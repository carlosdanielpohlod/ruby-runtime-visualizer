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

| Configuration                          | workload  |        | hot loop  |         |
|----------------------------------------|----------:|-------:|----------:|--------:|
| untraced                               |  42.85 ms |  1.00x |   4.11 ms |   1.00x |
| thread hooks only                      |  46.00 ms |  1.07x |   5.31 ms |   1.29x |
| thread hooks + GC                      |  44.02 ms |  1.03x |   5.03 ms |   1.23x |
| thread hooks + GC + probes (default)   |  45.52 ms |  1.06x |   5.24 ms |   1.28x |
| + source lines (`--lines`)             | 3251.0 ms | 75.9x  | 350.90 ms |  85.5x  |

Ruby 3.2.5:

| Configuration                          | workload  |        | hot loop  |         |
|----------------------------------------|----------:|-------:|----------:|--------:|
| untraced                               |  27.16 ms |  1.00x |   1.91 ms |   1.00x |
| thread hooks only                      |  29.15 ms |  1.07x |   2.74 ms |   1.43x |
| thread hooks + GC                      |  27.30 ms |  1.01x |   2.70 ms |   1.41x |
| thread hooks + GC + probes (default)   |  27.74 ms |  1.02x |   2.69 ms |   1.40x |
| + source lines (`--lines`)             | 2556.7 ms | 94.2x  | 313.44 ms | 163.8x  |

Event counts for the same runs: the default channels record 40–55 events
for the workload and 18 for the hot loop; `--lines` records about
394,000 and 100,000 respectively.

Reading these:

- With the default channels the difference on the 40 ms workload is a
  few percent, within run-to-run noise. The fixed session cost of about
  a millisecond (open the file, snapshot `Thread.list`, drain, write
  JSON) dominates the small hot-loop numbers.
- Source line tracing is a different regime. Two threads counting to
  50,000 produce 100,000 line events; `examples/cpu_threads.rb` produces
  twenty million and ran 20x slower in an early experiment while
  dropping most of them. The channel exists to answer "where was this
  thread", not to be left on.
- Absolute times depend on the machine's state; the ratios are what
  matters, and they move too. An earlier run on the same machine, with
  the machine busier, measured 24x–144x for the line channel.

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
