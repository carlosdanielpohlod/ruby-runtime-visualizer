#include "recorder.h"
#include "thread_identity.h"

#include <ruby/debug.h>
#include <ruby/thread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    rv_event_buffer *buffer;
    rb_internal_thread_event_hook_t *hook;
    VALUE gc_tracepoint;

    /*
     * Checked first thing in every hook. Stopping flips it before the hook
     * is unregistered, and a forked child flips it without unregistering at
     * all, so a stale hook invocation always finds a closed door.
     */
    _Atomic bool active;

    /*
     * Which registration the hooks belong to. A forked child inherits the
     * parent's hook and tracepoint registrations and cannot safely remove
     * the hook, so every callback carries the generation it was registered
     * with and ignores events once the recorder has moved on.
     */
    uintptr_t generation;

    _Atomic uint64_t threads_unidentified;

    uint64_t started_at_ns;
    uint64_t stopped_at_ns;
    uint64_t events_recorded;
    uint64_t dropped_reported;
    uint64_t unidentified_reported;
    uint64_t drain_count;
} rv_recorder;

static rv_recorder recorder;

/* ------------------------------------------------------------------------ */
/* Recording                                                                */
/* ------------------------------------------------------------------------ */

/*
 * The one function every channel funnels through. It is the whole extent of
 * the work done inside CRuby's callbacks: a clock read (done by the caller),
 * an atomic slot claim and a 32-byte store.
 */
static bool record(const rv_event *event)
{
    if (event->ruby_thread == 0) {
        atomic_fetch_add_explicit(&recorder.threads_unidentified, 1, memory_order_relaxed);
    }
    return rv_event_buffer_push(recorder.buffer, event, NULL);
}

static uint16_t event_type_for(rb_event_flag_t event)
{
    switch (event) {
      case RUBY_INTERNAL_THREAD_EVENT_STARTED:   return RV_EVENT_THREAD_STARTED;
      case RUBY_INTERNAL_THREAD_EVENT_READY:     return RV_EVENT_THREAD_READY;
      case RUBY_INTERNAL_THREAD_EVENT_RESUMED:   return RV_EVENT_THREAD_RESUMED;
      case RUBY_INTERNAL_THREAD_EVENT_SUSPENDED: return RV_EVENT_THREAD_SUSPENDED;
      case RUBY_INTERNAL_THREAD_EVENT_EXITED:    return RV_EVENT_THREAD_EXITED;
      default:                                   return 0;
    }
}

/*
 * Called by CRuby's thread scheduler.
 *
 *   READY      just before the thread is queued for the VM lock. On 3.3+ this
 *              can run on a *different* native thread (whoever woke us up).
 *   RESUMED    sched->running == th. The only event delivered with the GVL.
 *   SUSPENDED  the thread is giving the lock up. Delivered without the GVL.
 *   STARTED    3.2: on the new native thread. 3.3+: on the creating thread.
 *   EXITED     the Ruby thread is finished.
 *
 * On every version the caller holds, or is about to take, the scheduler's
 * own lock, and CRuby holds the hook list's read lock around us. Nothing in
 * here may block, allocate through Ruby, raise, or touch Ruby objects other
 * than reading event_data->thread's specific slot.
 */
static bool current_generation_p(void *user_data)
{
    return (uintptr_t)user_data == recorder.generation;
}

static void on_thread_event(rb_event_flag_t event, const rb_internal_thread_event_data_t *event_data, void *user_data)
{
    if (!current_generation_p(user_data)) return;
    if (!atomic_load_explicit(&recorder.active, memory_order_acquire)) return;

    rv_event ev = {
        .timestamp_ns  = rv_monotonic_now_ns(),
        .ruby_thread   = rv_thread_serial_for_event(event, event_data),
        .native_thread = rv_native_thread_id(),
        .type          = event_type_for(event),
    };
    if (ev.type == 0) return;
    record(&ev);
}

/*
 * Called by the GC through a TracePoint on RUBY_INTERNAL_EVENT_GC_ENTER and
 * GC_EXIT. Runs on the thread that triggered the collection, with the GVL,
 * but *inside* the collector: allocating any Ruby object here is forbidden.
 */
static void on_gc_event(VALUE tpval, void *user_data)
{
    if (!current_generation_p(user_data)) return;
    if (!atomic_load_explicit(&recorder.active, memory_order_acquire)) return;

    rb_event_flag_t flag = rb_tracearg_event_flag(rb_tracearg_from_tracepoint(tpval));
    rv_event ev = {
        .timestamp_ns  = rv_monotonic_now_ns(),
        .ruby_thread   = rv_thread_serial_current(),
        .native_thread = rv_native_thread_id(),
        .type          = (flag == RUBY_INTERNAL_EVENT_GC_ENTER) ? RV_EVENT_GC_ENTER : RV_EVENT_GC_EXIT,
    };
    record(&ev);
}

bool rv_recorder_mark(rv_event_type type, uint32_t arg0, uint32_t arg1)
{
    if (!atomic_load_explicit(&recorder.active, memory_order_acquire)) return false;

    rv_event ev = {
        .timestamp_ns  = rv_monotonic_now_ns(),
        .ruby_thread   = rv_thread_serial_current(),
        .native_thread = rv_native_thread_id(),
        .type          = (uint16_t)type,
        .arg0          = arg0,
        .arg1          = arg1,
    };
    return record(&ev);
}

/* ------------------------------------------------------------------------ */
/* Lifecycle                                                                */
/* ------------------------------------------------------------------------ */

void rv_recorder_init(void)
{
    memset(&recorder, 0, sizeof(recorder));
    recorder.gc_tracepoint = Qnil;
    rb_global_variable(&recorder.gc_tracepoint);
    atomic_init(&recorder.active, false);
    atomic_init(&recorder.threads_unidentified, 0);
}

bool rv_recorder_active_p(void)
{
    return atomic_load_explicit(&recorder.active, memory_order_acquire);
}

void rv_recorder_start(size_t buffer_capacity, unsigned options)
{
    if (rv_recorder_active_p()) rb_raise(rb_eRuntimeError, "recorder is already running");

    if (recorder.buffer && rv_event_buffer_capacity(recorder.buffer) != rv_event_buffer_round_capacity(buffer_capacity)) {
        rv_event_buffer_free(recorder.buffer);
        recorder.buffer = NULL;
    }
    if (!recorder.buffer) {
        recorder.buffer = rv_event_buffer_new(buffer_capacity);
        if (!recorder.buffer) rb_raise(rb_eNoMemError, "could not allocate the event buffer");
    }
    else {
        /* no hook is installed, so nobody can be pushing: safe to restart at sequence 1 */
        rv_event_buffer_reset(recorder.buffer);
    }

    recorder.started_at_ns = 0;
    recorder.stopped_at_ns = 0;
    recorder.events_recorded = 0;
    recorder.drain_count = 0;
    recorder.dropped_reported = 0;
    recorder.unidentified_reported = atomic_load(&recorder.threads_unidentified);

    /* the starting thread gets its serial before any hook can observe it */
    rv_thread_serial_current();

    recorder.generation++;
    atomic_store_explicit(&recorder.active, true, memory_order_release);

    recorder.started_at_ns = rv_monotonic_now_ns();
    rv_event started = {
        .timestamp_ns  = recorder.started_at_ns,
        .ruby_thread   = rv_thread_serial_current(),
        .native_thread = rv_native_thread_id(),
        .type          = RV_EVENT_TRACING_STARTED,
    };
    record(&started);

    recorder.hook = rb_internal_thread_add_event_hook(
        on_thread_event,
        RUBY_INTERNAL_THREAD_EVENT_STARTED |
        RUBY_INTERNAL_THREAD_EVENT_READY |
        RUBY_INTERNAL_THREAD_EVENT_RESUMED |
        RUBY_INTERNAL_THREAD_EVENT_SUSPENDED |
        RUBY_INTERNAL_THREAD_EVENT_EXITED,
        (void *)recorder.generation);

    if (options & RV_RECORDER_OPT_GC_EVENTS) {
        recorder.gc_tracepoint = rb_tracepoint_new(Qnil,
            RUBY_INTERNAL_EVENT_GC_ENTER | RUBY_INTERNAL_EVENT_GC_EXIT, on_gc_event, (void *)recorder.generation);
        rb_tracepoint_enable(recorder.gc_tracepoint);
    }
}

void rv_recorder_stop(void)
{
    if (!rv_recorder_active_p()) rb_raise(rb_eRuntimeError, "recorder is not running");

    recorder.stopped_at_ns = rv_monotonic_now_ns();
    rv_event stopped = {
        .timestamp_ns  = recorder.stopped_at_ns,
        .ruby_thread   = rv_thread_serial_current(),
        .native_thread = rv_native_thread_id(),
        .type          = RV_EVENT_TRACING_STOPPED,
    };
    record(&stopped);

    /* close the door first, then remove the hook: a hook that races us sees inactive */
    atomic_store_explicit(&recorder.active, false, memory_order_release);

    if (recorder.hook) {
        rb_internal_thread_remove_event_hook(recorder.hook);
        recorder.hook = NULL;
    }
    if (!NIL_P(recorder.gc_tracepoint)) {
        rb_tracepoint_disable(recorder.gc_tracepoint);
        recorder.gc_tracepoint = Qnil;
    }
}

void rv_recorder_reset_after_fork(void)
{
    atomic_store_explicit(&recorder.active, false, memory_order_release);

    /*
     * The inherited hook stays registered (see recorder.h) but will never
     * match the generation again. Disabling a tracepoint only needs the
     * GVL, which the child holds here, so that one is switched off for real.
     */
    recorder.generation++;
    recorder.hook = NULL;
    if (!NIL_P(recorder.gc_tracepoint)) {
        rb_tracepoint_disable(recorder.gc_tracepoint);
        recorder.gc_tracepoint = Qnil;
    }

    rv_thread_identity_reset_after_fork();
    if (recorder.buffer) rv_event_buffer_reset(recorder.buffer);
    recorder.stopped_at_ns = rv_monotonic_now_ns();
}

/* ------------------------------------------------------------------------ */
/* Draining                                                                 */
/* ------------------------------------------------------------------------ */

static void report_counter(uint64_t current, uint64_t *reported, rv_event_type type)
{
    if (current == *reported) return;
    rv_event ev = {
        .timestamp_ns  = rv_monotonic_now_ns(),
        .ruby_thread   = rv_thread_serial_current(),
        .native_thread = rv_native_thread_id(),
        .type          = (uint16_t)type,
        .arg0          = (uint32_t)(current - *reported),
    };
    /* the ring was just drained, so there is room for one more */
    if (rv_event_buffer_push(recorder.buffer, &ev, NULL)) *reported = current;
}

size_t rv_recorder_drain(size_t limit, rv_drain_callback yield, void *arg)
{
    if (!recorder.buffer) return 0;

    size_t count = 0;
    rv_event ev;
    uint64_t sequence;

    while (count < limit && rv_event_buffer_pop(recorder.buffer, &ev, &sequence)) {
        yield(sequence, &ev, arg);
        count++;
    }

    /*
     * Bookkeeping events are pushed *after* the batch so they get a real
     * sequence number and, if the ring was full, a slot that is now free.
     * They describe what happened between the previous drain and now. The
     * loop below pops at most two more events: normally exactly those, or,
     * when the batch stopped at `limit`, whatever was queued next.
     */
    report_counter(rv_event_buffer_dropped(recorder.buffer), &recorder.dropped_reported, RV_EVENT_EVENTS_DROPPED);
    report_counter(atomic_load(&recorder.threads_unidentified), &recorder.unidentified_reported, RV_EVENT_THREADS_UNIDENTIFIED);
    while (count < limit + 2 && rv_event_buffer_pop(recorder.buffer, &ev, &sequence)) {
        yield(sequence, &ev, arg);
        count++;
    }

    recorder.events_recorded += count;
    if (count > 0) recorder.drain_count++;
    return count;
}

void rv_recorder_get_stats(rv_recorder_stats *out)
{
    memset(out, 0, sizeof(*out));
    out->events_recorded        = recorder.events_recorded;
    out->events_dropped         = recorder.buffer ? rv_event_buffer_dropped(recorder.buffer) : 0;
    out->buffer_high_water_mark = recorder.buffer ? rv_event_buffer_high_water_mark(recorder.buffer) : 0;
    out->buffer_capacity        = recorder.buffer ? rv_event_buffer_capacity(recorder.buffer) : 0;
    out->threads_seen           = rv_thread_serials_assigned();
    out->threads_unidentified   = atomic_load(&recorder.threads_unidentified);
    out->started_at_ns          = recorder.started_at_ns;
    out->stopped_at_ns          = recorder.stopped_at_ns;
    out->drain_count            = recorder.drain_count;
    out->active                 = rv_recorder_active_p();
}
