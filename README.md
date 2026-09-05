# Ruby Runtime Visualizer

Watch what CRuby's thread scheduler actually did.

The recorder subscribes to CRuby's internal thread instrumentation
(`rb_internal_thread_add_event_hook`), so every `wants GVL`, `acquired`,
`released`, `started` and `exited` in a trace is the scheduler's own
transition, timestamped from inside the VM. The viewer turns that into a
timeline with a lane per Ruby thread, a lane for GVL ownership, a
native-thread view for M:N scheduling, and a replay transport.

Nothing is simulated. When a fact is derived from other facts, the trace
and the UI say so.

```
$ runtime-visualizer trace examples/cpu_threads.rb
$ runtime-visualizer inspect cpu_threads.rvtrace

time         ruby_thread    native    event                  cruby event
    0.000 ms main           304051    tracing_started        -
    0.383 ms Thread #2      304051    thread_started         RUBY_INTERNAL_THREAD_EVENT_STARTED
    0.531 ms Thread #2      304051    wants_gvl              RUBY_INTERNAL_THREAD_EVENT_READY
    0.607 ms main           304051    gvl_released           RUBY_INTERNAL_THREAD_EVENT_SUSPENDED
    0.733 ms Thread #2      304135    gvl_acquired           RUBY_INTERNAL_THREAD_EVENT_RESUMED
  102.454 ms Thread #2      304135    gvl_released           RUBY_INTERNAL_THREAD_EVENT_SUSPENDED
  102.459 ms Thread #2      304135    wants_gvl              RUBY_INTERNAL_THREAD_EVENT_READY
  102.610 ms Thread #3      304136    gvl_acquired           RUBY_INTERNAL_THREAD_EVENT_RESUMED
  ...
```

## Requirements

- CRuby 3.2 or newer, on Linux. Tested on 3.2, 3.3, 3.4 and 4.0, with and
  without `RUBY_MN_THREADS=1`.
- A C compiler for the native extension.
- Node 20+ for the web viewer.

JRuby, TruffleRuby and Windows are not supported: the instrumentation
API does not exist there.

## Install

```
git clone https://github.com/carlosdanielpohlod/ruby-runtime-visualizer
cd ruby-runtime-visualizer
bundle install
bundle exec rake compile
```

## Record a trace

```
bundle exec exe/runtime-visualizer trace examples/cpu_threads.rb
bundle exec exe/runtime-visualizer trace --lines examples/source_lines.rb
bundle exec exe/runtime-visualizer trace -o out.rvtrace your_script.rb --arg-for-your-script
```

Options:

| Flag                 | Effect |
|----------------------|--------|
| `-o PATH`            | Output file (default `<script>.rvtrace`). |
| `--lines`            | Record every source line through `TracePoint`. Very high overhead; see below. |
| `--no-gc`            | Skip GC enter/exit events. |
| `--no-sleep-probe`   | Do not observe `Kernel#sleep`. |
| `--no-mutex-probe`   | Do not observe `Thread::Mutex`. |
| `--buffer N`         | Ring buffer capacity in events (default 262,144). |
| `--drain-interval S` | Drain the ring from a background thread every S seconds. |

From Ruby:

```ruby
require "runtime_visualizer"

RuntimeVisualizer.trace("out.rvtrace") do
  threads = 2.times.map { Thread.new { work } }
  threads.each(&:join)
end
```

## Read a trace

```
bundle exec exe/runtime-visualizer inspect out.rvtrace     # event table + per-thread summary
bundle exec exe/runtime-visualizer stats out.rvtrace       # recorder statistics, dropped events
bundle exec exe/runtime-visualizer export --perfetto out.rvtrace -o out.json   # for ui.perfetto.dev
```

## The viewer

```
cd web
npm install
npm run dev
```

Open the printed URL and drop an `.rvtrace` file on the page. The viewer
shows:

- one lane per Ruby thread with its states: `STARTED`, `WANTS_GVL`,
  `RUNNING`, `SUSPENDED`, `PREEMPTED`, `SLEEPING`, `WAITING_MUTEX`, `EXITED`;
- the GVL ownership lane, with `idle` drawn explicitly;
- a native-thread view, where several Ruby threads can share one native
  thread under M:N scheduling;
- an inspector that names the CRuby event behind each segment, its
  meaning, its timestamp, and whether the fact was observed or derived;
- source lines per thread when the trace was recorded with `--lines`;
- play/pause, step by event, scrub, speed control, zoom and pan.

## What is observed and what is derived

| Fact | Comes from | Precision |
|------|-----------|-----------|
| A thread wants, got or released the GVL | `RUBY_INTERNAL_THREAD_EVENT_READY / RESUMED / SUSPENDED` | observed |
| A thread started or exited | `RUBY_INTERNAL_THREAD_EVENT_STARTED / EXITED` | observed |
| GC started or finished | `RUBY_INTERNAL_EVENT_GC_ENTER / EXIT` | observed |
| A thread called `sleep` | a Ruby-level probe around `Kernel#sleep` | observed (the call), not the scheduler's reason |
| A thread is `SLEEPING` | a `SUSPENDED` interval enclosed by the sleep probe | derived |
| A thread is `WAITING_MUTEX` | a `SUSPENDED` interval enclosed by the mutex probe | derived |
| A thread was `PREEMPTED` (3.2) | another thread's `RESUMED` while this one had not released | derived |
| Who owns the GVL between two events | the last `RESUMED` not followed by `SUSPENDED` | derived |
| A thread's state before its first event | nothing | inferred |

CRuby does not report why a thread released the lock, which ractor it
belongs to, or (on 3.3+) on which native thread a `READY` was delivered.
The trace carries these gaps as `null`s and `unknown`s rather than
guesses. `docs/limitations.md` has the full list.

## Overhead

The scheduler hooks, the GC tracepoint and the probes cost a few percent
on a thread-heavy workload; within noise on longer ones. Source line
tracing costs 25x to 140x and changes when timeslices expire. Numbers
and method are in `docs/tracing-overhead.md`, and every trace header
lists the channels that were on so the reader knows what perturbed it.

## Trace mode versus controlled mode

Everything here is **trace mode**: the program was not intentionally
paused or synchronised by the tool; instrumentation overhead still
exists. A debugger-like **controlled mode** (pause, step) is a different
feature with different guarantees. Its design, and why it must not be
built on the scheduler hooks, is in `docs/controlled-execution.md`.

## Documentation

- `docs/research.md` — what CRuby exposes, verified by reading
  `thread_pthread.c` for each version and by experiment
- `docs/event-protocol.md` — the `.rvtrace` format and the state model
- `docs/cruby-hooks.md` — the APIs used and the safety rules
- `docs/architecture.md` — the layers and the reasoning behind them
- `docs/tracing-overhead.md` — measured cost per channel
- `docs/limitations.md` — what cannot be seen
- `docs/controlled-execution.md` — design notes for pause/step

## Development

```
bundle exec rake compile     # build ext/ into lib/
bundle exec rake spec        # 89 examples, run on every supported Ruby
ruby -Ilib benchmarks/overhead.rb
cd web && npm test
```

The native extension is written to be read. Each hook callback explains
which lock the caller holds and why it cannot call into Ruby.

## Acknowledgements

The instrumentation approach follows the ground laid by Ivo Anjo's
[gvl-tracing](https://github.com/ivoanjo/gvl-tracing) (MIT), which first
showed how to observe the GVL through these hooks and export the result
to Perfetto. This project uses the same CRuby mechanisms with a
different pipeline: a lock-free ring instead of writing from the
callback, a versioned protocol with provenance, and an interactive viewer.

## License

MIT. See `LICENSE`.
