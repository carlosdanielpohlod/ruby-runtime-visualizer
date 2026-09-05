# Tracing overhead

Instrumentation changes the timing of what it observes. This page states
what each channel costs, how it was measured, and what the numbers do and
do not mean. Reproduce with:

```
ruby -Ilib benchmarks/overhead.rb
```

## Channels and their cost class

| Channel                        | Header name                   | Default | Cost   |
|--------------------------------|-------------------------------|---------|--------|
| CRuby thread scheduler hooks   | `cruby_internal_thread_event` | on      | LOW    |
| GC enter/exit tracepoint       | `cruby_gc_tracepoint`         | on      | LOW    |
| `Kernel#sleep` probe           | `probe:sleep`                 | on      | LOW    |
| `Thread::Mutex` probe          | `probe:mutex`                 | on      | LOW    |
| Source lines (`--lines`)       | `tracepoint:line`             | off     | VERY HIGH |

The low channels record one event per scheduler transition, per
collection or per probed call. Their per-event cost is a monotonic clock
read (vDSO), a serial lookup, one CAS and one 32-byte store, executed
while CRuby already holds the scheduler lock. A session also pays a fixed
cost at start and stop: opening the file, snapshotting `Thread.list`,
draining and writing JSON.

The line channel records one event per Ruby line executed and needs a
background drain thread to keep up; that thread competes for the GVL.

## Measurements

Machine: Linux 6.8, x86_64, glibc 2.39. Median of 5 rounds after a
warm-up. "workload" is four threads that each count to 200,000 twice
with a 5 ms sleep in between; "hot loop" is two threads counting to
50,000. The traced runs include session start/stop, which is why the
short hot loop shows a larger relative cost with nearly no events.

Ruby 3.4.8:

| Configuration                          | workload  |        | hot loop |         |
|----------------------------------------|----------:|-------:|---------:|--------:|
| untraced                               |  90.07 ms |  1.00x |  7.59 ms |   1.00x |
| thread hooks only                      |  96.76 ms |  1.07x | 10.43 ms |   1.37x |
| thread hooks + GC                      |  95.98 ms |  1.07x |  9.10 ms |   1.20x |
| thread hooks + GC + probes (default)   |  94.97 ms |  1.05x | 10.02 ms |   1.32x |
| + source lines (`--lines`)             | 2196.5 ms | 24.4x  | 785.9 ms | 103.6x  |

Ruby 3.2.5:

| Configuration                          | workload  |        | hot loop |         |
|----------------------------------------|----------:|-------:|---------:|--------:|
| untraced                               |  66.75 ms |  1.00x |  5.11 ms |   1.00x |
| thread hooks only                      |  65.19 ms |  0.98x |  7.31 ms |   1.43x |
| thread hooks + GC                      |  62.43 ms |  0.94x |  7.43 ms |   1.45x |
| thread hooks + GC + probes (default)   |  61.42 ms |  0.92x |  6.61 ms |   1.29x |
| + source lines (`--lines`)             | 2215.5 ms | 33.2x  | 737.1 ms | 144.3x  |

Reading these:

- With the default channels the difference on the 90 ms workload is
  within run-to-run noise (3.2 even came out faster traced, which is
  noise, not a speed-up). The fixed session cost of roughly 2–3 ms
  dominates the small hot-loop numbers.
- Source line tracing is a different regime. Two threads counting to
  50,000 produce 112,000 line events; `examples/cpu_threads.rb` produces
  twenty million and ran 20x slower in an early experiment while
  dropping most of them. The channel exists to answer "where was this
  thread", not to be left on.

## How the schedule itself changes

Beyond wall time, the line channel alters *which* schedule happens:

- Each line takes longer, so the 100 ms timeslice expires at a different
  line than it would have.
- The drain thread wakes every 50 ms, wants the GVL, and pushes other
  threads to READY.
- The TracePoint callback allocates (the mark call is Ruby-level), which
  changes GC timing.

The trace is still a true record of what the instrumented process did.
It is not a record of what the uninstrumented process would have done.
The header lists the channels so a reader can tell the two apart, and
the recorder's own thread is identified by `recorder_thread_id`.

## Ring buffer sizing

Default capacity is 262,144 events (16 MiB with the 64-byte slots). The
default channels produce a few events per thread switch, so the ring is
drained once at stop and never fills in practice; `stats` reports
`buffer_high_water_mark` so you can see how close it came. With
`--lines`, the drain thread runs every 50 ms; a program executing more
than ~5 million lines per second will still overflow, and the trace will
say so with an `events_dropped` record.
