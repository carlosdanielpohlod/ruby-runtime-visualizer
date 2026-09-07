/*
 * The recorder: hook registration, timestamping, buffering, statistics.
 *
 * There is one recorder per process because CRuby's hook list is global and
 * the events describe the whole VM. The recorder can be started and stopped
 * repeatedly; each start is a session with its own start timestamp.
 *
 * Data flow:
 *
 *   CRuby scheduler ──hook──▶ on_thread_event()  ─┐
 *   CRuby GC        ──tp────▶ on_gc_event()       ├─▶ rv_event ─▶ ring buffer ─▶ rv_recorder_drain() ─▶ Ruby
 *   Ruby probes     ──GVL───▶ rv_recorder_mark()  ─┘
 *
 * Everything left of the ring buffer must be safe without the GVL and must
 * never block. Everything right of it runs on a Ruby thread holding the GVL.
 */
#ifndef RV_RECORDER_H
#define RV_RECORDER_H

#include <ruby/ruby.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "event_buffer.h"

enum {
    RV_RECORDER_OPT_GC_EVENTS = 1 << 0
};

typedef struct {
    uint64_t events_recorded;      /* handed to Ruby so far, including bookkeeping events */
    uint64_t events_dropped;       /* rejected by a full ring */
    uint64_t buffer_high_water_mark;
    uint64_t buffer_capacity;
    uint64_t threads_seen;         /* serials assigned in this process */
    uint64_t threads_unidentified; /* events whose thread could not be identified */
    uint64_t started_at_ns;
    uint64_t stopped_at_ns;        /* 0 while running */
    uint64_t drain_count;          /* drains that moved at least one event */
    bool     active;
} rv_recorder_stats;

/* Called once at extension load. */
void rv_recorder_init(void);

/* Requires the GVL. Raises if already active or if allocation fails. */
void rv_recorder_start(size_t buffer_capacity, unsigned options);

/* Requires the GVL. Raises if not active. Events stay in the ring until drained. */
void rv_recorder_stop(void);

bool rv_recorder_active_p(void);

/*
 * Record an event on behalf of the calling Ruby thread. Requires the GVL.
 * Used by the Ruby-level probes (sleep, mutex, source lines). Returns false
 * if the recorder is inactive or the event was dropped.
 */
bool rv_recorder_mark(rv_event_type type, uint32_t arg0, uint32_t arg1);

/*
 * Move up to `limit` events out of the ring, calling `yield` for each, in
 * sequence order. Requires the GVL; one caller at a time. Emits bookkeeping
 * events (events_dropped, threads_unidentified) when the counters moved
 * since the previous drain. Returns how many events were yielded.
 */
typedef void (*rv_drain_callback)(uint64_t sequence, const rv_event *event, void *arg);
size_t rv_recorder_drain(size_t limit, rv_drain_callback yield, void *arg);

void rv_recorder_get_stats(rv_recorder_stats *out);

/*
 * To be called in a forked child before anything else. The child inherited
 * the parent's hook registration and a copy of the ring. We cannot safely
 * unregister the inherited hook (another parent thread may have held the
 * hook rwlock at fork time), so it is left in place and neutralised, and a
 * fresh session can be started afterwards.
 */
void rv_recorder_reset_after_fork(void);

#endif
