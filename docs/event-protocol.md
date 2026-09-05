# Event protocol

Everything downstream of the native recorder (the Ruby model, the exporters,
the web UI) speaks this protocol. The native extension never produces JSON;
it produces fixed-size structs that the Ruby layer normalises into these
records. Perfetto and other formats are exporters *from* this protocol.

Schema version: **1**.

## Container: `.rvtrace`

An `.rvtrace` file is newline-delimited JSON (NDJSON), UTF-8, one record per
line. Every record has a `record` field naming its kind. Readers must ignore
record kinds and fields they do not know.

Record order is: one `header`, then `event` records in `sequence` order,
then `thread` records, then one `stats`, then one `end`. A file may end
early (the process crashed); readers must accept a missing tail.

If the traced process forks while recording, the child writes its own file.
Each file has exactly one `process_id`.

### `header`

```json
{
  "record": "header",
  "format": "rvtrace",
  "schema_version": 1,
  "process_id": 9122,
  "ruby_version": "3.4.8",
  "ruby_engine": "ruby",
  "ruby_platform": "x86_64-linux",
  "clock": "CLOCK_MONOTONIC",
  "clock_unit": "ns",
  "trace_start_ns": 82736178263812,
  "scheduler": { "mn_threads": false, "timeslice_ms": 100 },
  "channels": ["cruby_internal_thread_event", "cruby_gc_tracepoint", "probe:sleep"],
  "buffer_capacity": 262144,
  "script": "examples/cpu_threads.rb"
}
```

- `trace_start_ns` is the absolute monotonic timestamp of the
  `tracing_started` event. Event timestamps are absolute on the same
  clock; readers subtract `trace_start_ns` for display.
- `channels` lists the instrumentation sources that were enabled. A reader
  can tell "no sleep events" apart from "sleep probe was off".
- `scheduler.mn_threads` is whether `RUBY_MN_THREADS=1` was set. It is a
  hint, not an observation; CRuby does not report scheduler mode.

### `event`

```json
{
  "record": "event",
  "sequence": 381,
  "timestamp_ns": 82736178381009,
  "ruby_thread_id": 4,
  "native_thread_id": 9218,
  "ractor_id": 1,
  "type": "gvl_acquired",
  "native_event": "RUBY_INTERNAL_THREAD_EVENT_RESUMED",
  "source": "cruby_internal_thread_event",
  "precision": "observed",
  "metadata": { "native_thread_role": "self" }
}
```

| Field              | Type            | Meaning |
|--------------------|-----------------|---------|
| `sequence`         | integer ≥ 1     | Global order in which the recorder accepted the event. Strictly increasing within a file, no gaps. Ties in `timestamp_ns` are broken by `sequence`. |
| `timestamp_ns`     | integer         | `CLOCK_MONOTONIC` nanoseconds, read inside the callback before the event was enqueued. |
| `ruby_thread_id`   | integer         | Serial assigned by the recorder, starting at 1 for the thread that started tracing. `0` means the recorder could not identify the thread (see `stats.threads_unidentified`). |
| `native_thread_id` | integer         | `gettid()` of the native thread that executed the callback. |
| `ractor_id`        | integer or null | Reserved. `1` when the recorder derived that only the main ractor existed; `null` otherwise. |
| `type`             | string          | Normalised type, table below. |
| `native_event`     | string or null  | The CRuby constant, tracepoint, or method the event came from. |
| `source`           | string          | Which instrumentation channel produced it. |
| `precision`        | string          | `observed`, `derived` or `inferred` (defined below). |
| `metadata`         | object          | Type-specific extra fields. |

Fields that would be `null` may be omitted, except `ractor_id`, which is
always present so that its meaning is not forgotten.

### `thread`

```json
{ "record": "thread", "ruby_thread_id": 1, "name": "main", "main": true,
  "native_thread_id_at_start": 9122, "seen_native_thread_ids": [9122] }
```

Emitted for every thread the recorder identified. `name` is `Thread#name`
if it was set, `"main"` for the main thread, otherwise `null`. Names can
only be read from `Thread` objects that were still alive at a snapshot
(start, each drain, stop); a thread that lived and died between snapshots
has `name: null`.

### `stats`

```json
{
  "record": "stats",
  "events_recorded": 44,
  "events_dropped": 0,
  "buffer_high_water_mark": 44,
  "buffer_capacity": 262144,
  "threads_seen": 3,
  "threads_unidentified": 0,
  "tracing_duration_ns": 1207192000,
  "drain_count": 1
}
```

### `end`

```json
{ "record": "end", "trace_end_ns": 82737385455812 }
```

## Precision

| Value      | Meaning |
|------------|---------|
| `observed` | The runtime (or a probe running under the GVL) reported this fact directly. The timestamp is the moment the callback ran. |
| `derived`  | Computed from observed events by a deterministic rule that is documented next to the field. Example: a `SUSPENDED` interval that falls between `sleep_enter` and `sleep_exit` is labelled `SLEEPING`. |
| `inferred` | A best guess that could be wrong. Example: a thread's state before its first event in a trace. |

Events in a file are `observed`. Derived and inferred facts appear in
`metadata` of events, in the `thread` records, and in the state intervals
the model computes; each carries its own `precision`.

## Event types

### Channel `cruby_internal_thread_event` (all `observed`)

| `type`           | `native_event`                          | What CRuby means |
|------------------|-----------------------------------------|------------------|
| `thread_started` | `RUBY_INTERNAL_THREAD_EVENT_STARTED`    | A native thread is being created for this Ruby thread (3.3+: called by the creator; 3.2: called on the new thread). The thread has not run Ruby code yet. |
| `wants_gvl`      | `RUBY_INTERNAL_THREAD_EVENT_READY`      | The thread was put on the ready queue of its scheduler. It wants the lock. It may already own it if the queue was empty. |
| `gvl_acquired`   | `RUBY_INTERNAL_THREAD_EVENT_RESUMED`    | `sched->running == th`. The thread owns the lock and is about to run Ruby code. |
| `gvl_released`   | `RUBY_INTERNAL_THREAD_EVENT_SUSPENDED`  | The thread is giving up the lock: blocking region, sleep, yield, exit, or waiting on a condition. CRuby does not say which. |
| `thread_exited`  | `RUBY_INTERNAL_THREAD_EVENT_EXITED`     | The Ruby thread finished. |

`metadata.native_thread_role` (derived, from the CRuby version and event):

| Value        | Meaning |
|--------------|---------|
| `self`       | The callback ran on the Ruby thread's own native thread. |
| `creator`    | The callback ran on the thread that called `Thread.new` (STARTED on 3.3+). |
| `unknown`    | Could be the thread itself, a waker, or the timer thread (READY on 3.3+). |

Repeated events are recorded as they happened. Ruby 3.2 emits two
`SUSPENDED` in a row for `Kernel#sleep`; readers treat a transition into
the current state as a no-op.

### Channel `cruby_gc_tracepoint` (all `observed`)

| `type`     | `native_event`                 |
|------------|--------------------------------|
| `gc_enter` | `RUBY_INTERNAL_EVENT_GC_ENTER` |
| `gc_exit`  | `RUBY_INTERNAL_EVENT_GC_EXIT`  |

`ruby_thread_id` is the thread that was running when the GC started
(it owns the GVL during GC).

### Channel `probe:sleep` (`observed`; the *call* was observed, not the scheduler's reason)

| `type`        | `native_event`        | metadata |
|---------------|-----------------------|----------|
| `sleep_enter` | `Kernel#sleep`        | `requested_ms` (null for `sleep` without argument) |
| `sleep_exit`  | `Kernel#sleep`        | |

Implemented by prepending a module to `Kernel`; it runs with the GVL.

### Channel `probe:mutex` (`observed` call boundaries)

| `type`            | `native_event`      | metadata |
|-------------------|---------------------|----------|
| `mutex_lock_wait` | `Thread::Mutex#lock` | `mutex_id` |
| `mutex_acquired`  | `Thread::Mutex#lock` | `mutex_id` |
| `mutex_released`  | `Thread::Mutex#unlock` | `mutex_id` |

`mutex_id` is a small serial assigned by the probe, stable within a trace.
A `gvl_released` between `mutex_lock_wait` and `mutex_acquired` is
*derived* to be "waiting for mutex N". CRuby's thread hooks do not say that.

### Channel `tracepoint:line` (`observed`, high overhead)

| `type`        | `native_event`    | metadata |
|---------------|-------------------|----------|
| `source_line` | `TracePoint :line` | `path`, `line` |

### Channel `recorder`

| `type`             | metadata |
|--------------------|----------|
| `tracing_started`  | |
| `tracing_stopped`  | |
| `events_dropped`   | `count`: events the ring buffer rejected since the previous drain |
| `thread_pool_exhausted` | `count`: events that could not be attributed to a thread |

An `events_dropped` record is emitted the first time a drain notices the
drop counter moved. Its `timestamp_ns` is the drain time, not the time of
the first drop; the drop itself happened somewhere in the preceding gap.

## Thread state model

States are computed by the model from `cruby_internal_thread_event`
events, one lane per `ruby_thread_id`:

```
                 thread_started
       (none) ─────────────────▶ STARTED
                                    │ wants_gvl
                                    ▼
             ┌─────────────── WANTS_GVL ◀───────────────┐
             │ gvl_acquired                              │ wants_gvl
             ▼                                           │
          RUNNING ──── gvl_released ────▶ SUSPENDED ─────┤
             │                                           │
             │ wants_gvl (3.2 preemption, no SUSPENDED)  │
             └───────────────▶ WANTS_GVL                 │
                                                         │
          RUNNING ── another thread's gvl_acquired ──▶ (RUNNING ends; state becomes
                                                       PREEMPTED, precision derived)
             │
             │ thread_exited
             ▼
           EXITED
```

Rules, with precision:

- Transitions in the table are `observed`.
- `RUNNING` ends at the *earlier* of the thread's own `gvl_released` and
  another thread's `gvl_acquired` in the same ractor. When the latter
  closes it, the segment until the thread's next event is labelled
  `PREEMPTED` (derived): CRuby moved on without telling this thread.
- A `SUSPENDED` segment enclosed by `sleep_enter`/`sleep_exit` on the same
  thread is relabelled `SLEEPING` (derived). Enclosed by
  `mutex_lock_wait`/`mutex_acquired`: `WAITING_MUTEX` (derived). Otherwise
  it stays `SUSPENDED` and the reason is unknown.
- A thread whose first event in the trace is not `thread_started` gets an
  `inferred` initial state: `RUNNING` if its first event is
  `gvl_released`, `SUSPENDED` if it is `wants_gvl`, `UNKNOWN` otherwise.
- Repeated identical transitions (double `SUSPENDED`) do not open a new
  segment.

## GVL ownership lane

Owner at time *t* is the thread of the latest `gvl_acquired` with
`timestamp_ns ≤ t` whose thread has not emitted `gvl_released` or
`thread_exited` since, and which has not been superseded by a later
`gvl_acquired`. When no thread qualifies the lane shows `idle`. This is
`observed` at the endpoints and `derived` for the interval between them.

Invariant checked by the model: no two `gvl_acquired` events from
different threads may be open at once inside the same ractor. A violation
is reported, not hidden; it would indicate either a recorder bug or a
CRuby behaviour we have not modelled.

## Native representation

The native ring buffer stores this, 32 bytes per event plus an 8-byte
slot sequence, padded to a 64-byte cache line:

```c
typedef struct {
    uint64_t timestamp_ns;
    uint32_t ruby_thread;    /* serial, 0 = unidentified */
    uint32_t native_thread;  /* gettid() of the callback runner */
    uint16_t type;           /* rv_event_type */
    uint16_t flags;          /* reserved */
    uint32_t arg0;           /* type-specific: mutex id, path id, ... */
    uint32_t arg1;           /* type-specific: line number, ... */
} rv_event;
```

The `sequence` field of the protocol is the ring buffer position at which
the event was accepted, so it is assigned atomically and never reused.
