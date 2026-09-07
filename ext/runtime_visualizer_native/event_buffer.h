/*
 * A bounded, lock-free, multi-producer single-consumer ring of fixed-size
 * events.
 *
 * Producers are CRuby's internal thread hooks. They may run without the GVL,
 * while the scheduler lock is held, and on any native thread. That rules out
 * mutexes (a blocked producer would stall every thread switch in the
 * process), Ruby allocation, and anything that is not bounded in time.
 *
 * The consumer is Ruby code holding the GVL, calling drain() from one thread
 * at a time.
 *
 * The algorithm is Dmitry Vyukov's bounded MPMC queue: each slot carries its
 * own sequence number, so producers claim slots with a single CAS on the
 * enqueue position and publish them with a release store on the slot. When
 * the ring is full the push fails immediately and a drop counter is bumped;
 * nothing ever waits.
 */
#ifndef RV_EVENT_BUFFER_H
#define RV_EVENT_BUFFER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Event type codes. The numbers are part of the wire format between the
 * extension and the Ruby side (see lib/runtime_visualizer/event_types.rb),
 * so they are stable once published. Gaps leave room for future channels.
 */
typedef enum {
    /* recorder bookkeeping */
    RV_EVENT_TRACING_STARTED     = 1,
    RV_EVENT_TRACING_STOPPED     = 2,
    RV_EVENT_EVENTS_DROPPED      = 3, /* arg0 = count */
    RV_EVENT_THREADS_UNIDENTIFIED = 4, /* arg0 = count */

    /* rb_internal_thread_add_event_hook, one per RUBY_INTERNAL_THREAD_EVENT_* */
    RV_EVENT_THREAD_STARTED      = 10,
    RV_EVENT_THREAD_READY        = 11,
    RV_EVENT_THREAD_RESUMED      = 12,
    RV_EVENT_THREAD_SUSPENDED    = 13,
    RV_EVENT_THREAD_EXITED       = 14,

    /* RUBY_INTERNAL_EVENT_GC_ENTER / GC_EXIT tracepoint */
    RV_EVENT_GC_ENTER            = 20,
    RV_EVENT_GC_EXIT             = 21,

    /* Ruby-level probes, recorded through rv_recorder_mark() with the GVL */
    RV_EVENT_SLEEP_ENTER         = 30, /* arg0 = requested milliseconds, 0 if none */
    RV_EVENT_SLEEP_EXIT          = 31,
    RV_EVENT_MUTEX_LOCK_WAIT     = 32, /* arg0 = mutex id */
    RV_EVENT_MUTEX_ACQUIRED      = 33, /* arg0 = mutex id */
    RV_EVENT_MUTEX_RELEASED      = 34, /* arg0 = mutex id */

    /* TracePoint :line, recorded through rv_recorder_mark() with the GVL */
    RV_EVENT_SOURCE_LINE         = 40  /* arg0 = path id, arg1 = line number */
} rv_event_type;

/*
 * One recorded event. 32 bytes, plain data, no pointers, so that copying it
 * in and out of the ring is a couple of stores and the ring can be dumped
 * as-is if we ever want a binary format.
 */
typedef struct {
    uint64_t timestamp_ns;    /* CLOCK_MONOTONIC */
    uint32_t ruby_thread;     /* recorder-assigned serial, 0 = unidentified */
    uint32_t native_thread;   /* gettid() of the thread that ran the hook */
    uint16_t type;            /* rv_event_type */
    uint16_t flags;           /* reserved, always 0 for now */
    uint32_t arg0;            /* type specific */
    uint32_t arg1;            /* type specific */
} rv_event;

typedef struct rv_event_buffer rv_event_buffer;

/* The capacity a request will actually get: the next power of two. */
size_t rv_event_buffer_round_capacity(size_t capacity);

/* capacity is rounded up to a power of two; returns NULL on allocation failure */
rv_event_buffer *rv_event_buffer_new(size_t capacity);
void rv_event_buffer_free(rv_event_buffer *buffer);

/*
 * Producer side. Safe from any thread, with or without the GVL, never blocks.
 * On success stores the 1-based global sequence number of the event in
 * *sequence_out. Returns false, and counts a drop, when the ring is full.
 */
bool rv_event_buffer_push(rv_event_buffer *buffer, const rv_event *event, uint64_t *sequence_out);

/*
 * Consumer side. Only one thread may call this at a time. Returns false when
 * the ring is empty.
 */
bool rv_event_buffer_pop(rv_event_buffer *buffer, rv_event *event_out, uint64_t *sequence_out);

/*
 * Discard everything and restart positions at zero, so the next push gets
 * sequence 1. Only valid while no producer can run (hooks not installed).
 */
void rv_event_buffer_reset(rv_event_buffer *buffer);

size_t   rv_event_buffer_capacity(const rv_event_buffer *buffer);
uint64_t rv_event_buffer_dropped(const rv_event_buffer *buffer);
size_t   rv_event_buffer_high_water_mark(const rv_event_buffer *buffer);

#endif
