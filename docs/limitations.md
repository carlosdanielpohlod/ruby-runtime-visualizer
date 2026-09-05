# Limitations

What the recorder cannot see, cannot know, or deliberately does not do.
Everything here is either enforced by CRuby or a consequence of the
safety rules in `docs/cruby-hooks.md`.

## Platform

- CRuby only. The thread hooks are `thread_pthread.c`; JRuby and
  TruffleRuby have no equivalent and the build aborts on them.
- Linux only for milestone 1: `gettid()` and `CLOCK_MONOTONIC`. macOS
  would need `pthread_threadid_np`; Windows has no hooks at all.
- Ruby ≥ 3.2. Tested on 3.2.5, 3.3.0, 3.4.8 and 4.0.0, with and without
  `RUBY_MN_THREADS=1`.

## What CRuby does not tell us

- **Why a thread released the GVL.** `SUSPENDED` is one event for IO,
  sleep, `Thread.pass`, mutex contention, queue waits, condition
  variables and exit. The probes recover two reasons (`sleep`, `Mutex`)
  and mark them `derived`; everything else is `SUSPENDED`.
- **The ractor.** `event_data` carries only the thread. `ractor_id` is
  filled in as `1` when the process has a single ractor, `null`
  otherwise. Multi-ractor programs are recorded but their lanes are not
  separated by ractor yet.
- **Which Ruby thread, on 3.2.** `event_data` is `NULL`. Identity is a
  thread-local, correct because 3.2 is 1:1, and `Thread` objects are
  matched to serials through `Thread#native_thread_id`. A thread that is
  never alive during a snapshot has no name.
- **Where the thread runs, for `READY` on 3.3+.** The callback may run
  on the waker's native thread. `native_thread_role: unknown` says so and
  the native-thread view only uses `RESUMED`.
- **Thread names of threads that die between snapshots.** Names are read
  from `Thread` objects at start, at every drain and at stop. A thread
  born and finished in between is `Thread #N`.

## Known event sequences that look odd

Recorded as they happened; the model handles them:

- Ruby 3.2 emits two `SUSPENDED` for one `Kernel#sleep`.
- Ruby 3.2 emits no `SUSPENDED` for a timeslice preemption: the
  preempted thread reports `READY` while another thread reports
  `RESUMED`. The model closes the owner's RUNNING at the other thread's
  `RESUMED` and labels the gap `PREEMPTED` (derived).
- A `READY` immediately followed by `RESUMED` on the same thread means
  the ready queue was empty; the WANTS_GVL segment has zero or near-zero
  length.
- Two hooks on different cores may claim ring slots in the opposite order
  of their timestamps, so consecutive sequence numbers can carry
  timestamps a few microseconds out of order. Per thread the order is
  always consistent.

## Probes

- `Kernel.sleep(...)` with an explicit receiver bypasses the prepended
  module and is not seen. `sleep 1` (implicit receiver) is.
- `Mutex#synchronize` is re-implemented in Ruby on top of `lock`/`unlock`
  while the probe is on, because the C implementation bypasses method
  dispatch. `ConditionVariable#wait` releases the mutex inside C and is
  not seen. `Monitor` is not probed.
- Probes only run while a session is active; the prepended modules stay
  installed for the life of the process (Ruby cannot un-prepend) and cost
  one flag check per call afterwards.

## Recorder

- One session per process. The hooks and the ring are global.
- Dropped events are counted and reported, not recovered. The
  `events_dropped` record's timestamp is the drain time; the drops
  happened somewhere before it.
- The drain thread, when enabled, is a Ruby thread and appears in the
  trace (identified in the header).
- A forked child gets a new file; the parent's inherited hook stays
  registered in the child, disarmed. If the parent is killed with a
  signal the file ends without `thread`, `stats` and `end` records; the
  reader accepts that and reports the trace as incomplete.
- The line channel embeds source files up to 256 KiB each. Files that
  are larger or unreadable are listed by path only.

## Model

- Thread states are computed from events; between two events nothing is
  known, and the state shown is the one implied by the last event.
- The GVL lane treats each ractor as one lock domain but currently
  assumes a single domain, because `ractor_id` cannot be observed.
- The invariant "one RUNNING thread at a time" is checked by the tests
  on real traces. A violation is reported by `inspect`, never hidden.

## Not implemented

- Controlled execution (pause/step) — see `docs/controlled-execution.md`.
- Fibers, the fiber scheduler, Ractor lanes, YARV, YJIT, allocations.
- macOS, Windows, JRuby, TruffleRuby.
