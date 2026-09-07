# Architecture

```
 CRuby VM
 ├─ thread scheduler ── rb_internal_thread_add_event_hook ──┐
 ├─ garbage collector ── RUBY_INTERNAL_EVENT_GC_ENTER/EXIT ─┤   native, no GVL,
 │                                                          │   never blocks
 └─ Ruby code ── probes (sleep, mutex) / TracePoint :line ──┤   (with GVL)
                                                            ▼
                                              rv_event (32 bytes)
                                                            │
                                              lock-free ring buffer
                                                            │
                                     Native.drain  (Ruby thread, with GVL)
                                                            │
                                  Normalizer → Event (protocol vocabulary)
                                                            │
                                            TraceWriter → .rvtrace (NDJSON)
                                                            │
                          ┌─────────────────────────────────┼─────────────────────┐
                          ▼                                 ▼                     ▼
                     Trace / Timeline                  web/ (React)      Exporters::Perfetto
                     (Ruby model, CLI)               replay + inspector      (ui.perfetto.dev)
```

## Layers and their rules

### `ext/runtime_visualizer_native` — the collector

Runs inside CRuby's callbacks. Its contract: no Ruby allocation, no
locks, no I/O, bounded time, and no Ruby API beyond what each callback
is allowed: the two thread-specific accessors in the scheduler hooks,
plus `rb_tracearg_*` and `rb_thread_current` in the GC tracepoint, which
runs with the GVL. What it does per event is a `clock_gettime`, a serial
lookup, a CAS to claim a ring slot and a 32-byte store.

| File                    | Responsibility |
|-------------------------|----------------|
| `event_buffer.[ch]`     | Vyukov bounded MPMC ring. Push never blocks; full ring increments a drop counter. |
| `thread_identity.[ch]`  | Ruby thread serial (TLS on 3.2, thread-specific slot on 3.3+), cached `gettid()`, monotonic clock. |
| `recorder.[ch]`         | Hook registration, GC tracepoint, session lifecycle, drain, statistics, fork handling. |
| `runtime_visualizer_native.c` | The `RuntimeVisualizer::Native` module: `start`, `stop`, `drain`, `mark`, `stats`, identity helpers. |

The extension exposes integers only. It knows nothing about JSON, files,
thread names or state machines.

### `lib/runtime_visualizer` — the recorder and the model

| File                 | Responsibility |
|----------------------|----------------|
| `event_types.rb`     | Native type code → protocol `type`, `native_event`, `source`, `channel`. Verified against the extension at load. |
| `normalizer.rb`      | Integer tuples → `Event`. Adds `native_thread_role`, `ractor_id`, probe payload decoding. |
| `recorder.rb`        | A session: start, periodic or final drain, thread snapshots, header/tail, fork. |
| `thread_registry.rb` | Serial → name / main flag / native threads seen. |
| `probes/*.rb`        | Optional Ruby-level channels. Each declares its `channel` name for the header. |
| `trace_writer.rb`    | NDJSON output. |
| `trace.rb`           | NDJSON input into memory. |
| `timeline.rb`        | Reference implementation of the state model and GVL lane; used by the CLI, the Perfetto exporter and the tests. |
| `exporters/*.rb`     | Protocol → other formats. |
| `cli.rb`             | `trace`, `inspect`, `stats`, `export`. |

### `web/` — the viewer

Reads `.rvtrace` files, runs the same state model in TypeScript, and
renders lanes, the GVL track, a native-thread view, a source panel and a
replay transport. It has no knowledge of CRuby beyond the protocol and
the per-event meaning texts.

## Runtime adapters

The protocol and the viewer are runtime-agnostic. Only the collector is
CRuby-specific. A future JRuby or TruffleRuby adapter would need to
produce `Event` records with its own `source` values (for example
`jvm_thread_state`) and its own precision claims; nothing downstream
assumes a GVL exists, only that whatever lock the runtime has is
reported through `gvl_acquired` / `gvl_released` for one domain at a
time (`ractor_id`).

## Design decisions worth knowing

- **Ring, not queue of Ruby objects.** Producers cannot touch the Ruby
  heap. A 32-byte struct per event, padded to a cache line per slot.
- **Drop, never block.** A full ring rejects the event and counts it. The
  count becomes an `events_dropped` record at the next drain. The
  alternative, blocking the scheduler until the consumer catches up,
  would turn the tracer into the scheduler.
- **Sequence = ring position.** Assigned by the CAS that claims the slot,
  so it is unique and increasing without a second atomic.
- **Timestamps come from the hook, sequence from the ring.** Two hooks on
  different cores can read their clocks in one order and claim slots in
  the other, so within a few microseconds the two orders can disagree.
  Per thread the order is always consistent. Readers sort by sequence and
  treat timestamps as the physical time.
- **Serials, not native ids.** M:N scheduling moves Ruby threads between
  native threads; 3.2's thread cache reuses native threads. Native ids are
  an attribute of an event, not the identity of a thread.
- **Probes are separate channels with their own `source`.** A probe
  observes a Ruby-level call, not the scheduler's reason. The model
  derives reasons from correlation and marks them `derived`.
- **The drain thread is a real Ruby thread and says so.** With periodic
  draining on, the header carries `recorder_thread_id` so viewers can
  hide it. Without it (the default for the low-overhead channels) the
  ring is drained once at stop.
