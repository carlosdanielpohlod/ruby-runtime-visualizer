/*
 * Ruby bindings for the recorder. Everything here runs with the GVL; the
 * unsafe parts live in recorder.c and thread_identity.c.
 *
 * The module is deliberately thin: it exposes start/stop/drain/mark/stats
 * and a few identity helpers, and leaves normalisation, naming, file
 * formats and everything else to lib/runtime_visualizer.
 */
#include <ruby/ruby.h>
#include <ruby/thread.h>

#include "event_buffer.h"
#include "recorder.h"
#include "thread_identity.h"

#define RV_DEFAULT_BUFFER_CAPACITY 262144

static VALUE mRuntimeVisualizer;
static VALUE mNative;

/* Native.start(buffer_capacity, options) -> nil */
static VALUE native_start(VALUE self, VALUE buffer_capacity, VALUE options)
{
    size_t capacity = NUM2SIZET(buffer_capacity);
    if (capacity < 16) rb_raise(rb_eArgError, "buffer capacity must be at least 16");
    rv_recorder_start(capacity, NUM2UINT(options));
    return Qnil;
}

/* Native.stop -> nil */
static VALUE native_stop(VALUE self)
{
    rv_recorder_stop();
    return Qnil;
}

/* Native.active? -> true/false */
static VALUE native_active_p(VALUE self)
{
    return rv_recorder_active_p() ? Qtrue : Qfalse;
}

/*
 * Native.mark(type, arg0, arg1) -> true/false
 *
 * Records an event for the calling thread. Only the probe and tracepoint
 * type codes are accepted; the scheduler's own events cannot be forged
 * from Ruby.
 */
static VALUE native_mark(VALUE self, VALUE type, VALUE arg0, VALUE arg1)
{
    int code = NUM2INT(type);
    if (code < RV_EVENT_SLEEP_ENTER || code > RV_EVENT_SOURCE_LINE) {
        rb_raise(rb_eArgError, "event type %d cannot be recorded from Ruby", code);
    }
    return rv_recorder_mark((rv_event_type)code, NUM2UINT(arg0), NUM2UINT(arg1)) ? Qtrue : Qfalse;
}

static void push_event(uint64_t sequence, const rv_event *event, void *arg)
{
    VALUE array = (VALUE)arg;
    rb_ary_push(array, ULL2NUM(sequence));
    rb_ary_push(array, ULL2NUM(event->timestamp_ns));
    rb_ary_push(array, UINT2NUM(event->ruby_thread));
    rb_ary_push(array, UINT2NUM(event->native_thread));
    rb_ary_push(array, UINT2NUM(event->type));
    rb_ary_push(array, UINT2NUM(event->arg0));
    rb_ary_push(array, UINT2NUM(event->arg1));
}

/*
 * Native.drain(limit) -> Array
 *
 * Returns a flat array with FIELDS_PER_EVENT integers per event:
 * sequence, timestamp_ns, ruby_thread, native_thread, type, arg0, arg1.
 * A flat array of fixnums is cheap to build here and cheap to slice in
 * Ruby; no intermediate objects per event.
 */
static VALUE native_drain(VALUE self, VALUE limit)
{
    VALUE array = rb_ary_new();
    rv_recorder_drain(NUM2SIZET(limit), push_event, (void *)array);
    return array;
}

/* Native.stats -> Hash */
static VALUE native_stats(VALUE self)
{
    rv_recorder_stats stats;
    rv_recorder_get_stats(&stats);

    VALUE hash = rb_hash_new();
#define STAT(name) rb_hash_aset(hash, ID2SYM(rb_intern(#name)), ULL2NUM(stats.name))
    STAT(events_recorded);
    STAT(events_dropped);
    STAT(buffer_high_water_mark);
    STAT(buffer_capacity);
    STAT(threads_seen);
    STAT(threads_unidentified);
    STAT(started_at_ns);
    STAT(stopped_at_ns);
    STAT(drain_count);
#undef STAT
    rb_hash_aset(hash, ID2SYM(rb_intern("active")), stats.active ? Qtrue : Qfalse);
    return hash;
}

/* Native.thread_serial(thread) -> Integer (0 when it cannot be determined) */
static VALUE native_thread_serial(VALUE self, VALUE thread)
{
    if (!rb_obj_is_kind_of(thread, rb_cThread)) rb_raise(rb_eTypeError, "expected a Thread");
    return UINT2NUM(rv_thread_serial_of(thread));
}

/* Native.current_thread_serial -> Integer */
static VALUE native_current_thread_serial(VALUE self)
{
    return UINT2NUM(rv_thread_serial_current());
}

/* Native.current_native_thread_id -> Integer */
static VALUE native_current_native_thread_id(VALUE self)
{
    return UINT2NUM(rv_native_thread_id());
}

/* Native.monotonic_now_ns -> Integer, same clock as the events */
static VALUE native_monotonic_now_ns(VALUE self)
{
    return ULL2NUM(rv_monotonic_now_ns());
}

/* Native.reset_after_fork -> nil */
static VALUE native_reset_after_fork(VALUE self)
{
    rv_recorder_reset_after_fork();
    return Qnil;
}

void Init_runtime_visualizer_native(void)
{
    rv_thread_identity_init();
    rv_recorder_init();

    mRuntimeVisualizer = rb_define_module("RuntimeVisualizer");
    mNative = rb_define_module_under(mRuntimeVisualizer, "Native");

    rb_define_singleton_method(mNative, "start", native_start, 2);
    rb_define_singleton_method(mNative, "stop", native_stop, 0);
    rb_define_singleton_method(mNative, "active?", native_active_p, 0);
    rb_define_singleton_method(mNative, "mark", native_mark, 3);
    rb_define_singleton_method(mNative, "drain", native_drain, 1);
    rb_define_singleton_method(mNative, "stats", native_stats, 0);
    rb_define_singleton_method(mNative, "thread_serial", native_thread_serial, 1);
    rb_define_singleton_method(mNative, "current_thread_serial", native_current_thread_serial, 0);
    rb_define_singleton_method(mNative, "current_native_thread_id", native_current_native_thread_id, 0);
    rb_define_singleton_method(mNative, "monotonic_now_ns", native_monotonic_now_ns, 0);
    rb_define_singleton_method(mNative, "reset_after_fork", native_reset_after_fork, 0);

    rb_define_const(mNative, "FIELDS_PER_EVENT", INT2FIX(7));
    rb_define_const(mNative, "DEFAULT_BUFFER_CAPACITY", INT2FIX(RV_DEFAULT_BUFFER_CAPACITY));
    rb_define_const(mNative, "OPT_GC_EVENTS", INT2FIX(RV_RECORDER_OPT_GC_EVENTS));
    rb_define_const(mNative, "THREAD_IDENTITY_ATTACHED_TO_THREAD",
                    rv_thread_identity_attached_to_thread_p() ? Qtrue : Qfalse);

    /* event type codes, mirrored in lib/runtime_visualizer/event_types.rb */
    VALUE types = rb_hash_new();
#define EVENT_TYPE(name) rb_hash_aset(types, ID2SYM(rb_intern(#name)), INT2FIX(RV_EVENT_##name))
    EVENT_TYPE(TRACING_STARTED);
    EVENT_TYPE(TRACING_STOPPED);
    EVENT_TYPE(EVENTS_DROPPED);
    EVENT_TYPE(THREADS_UNIDENTIFIED);
    EVENT_TYPE(THREAD_STARTED);
    EVENT_TYPE(THREAD_READY);
    EVENT_TYPE(THREAD_RESUMED);
    EVENT_TYPE(THREAD_SUSPENDED);
    EVENT_TYPE(THREAD_EXITED);
    EVENT_TYPE(GC_ENTER);
    EVENT_TYPE(GC_EXIT);
    EVENT_TYPE(SLEEP_ENTER);
    EVENT_TYPE(SLEEP_EXIT);
    EVENT_TYPE(MUTEX_LOCK_WAIT);
    EVENT_TYPE(MUTEX_ACQUIRED);
    EVENT_TYPE(MUTEX_RELEASED);
    EVENT_TYPE(SOURCE_LINE);
#undef EVENT_TYPE
    rb_define_const(mNative, "EVENT_TYPES", rb_obj_freeze(types));
}
