# Research notes: observing threads and the GVL in CRuby

These notes were written before any recorder code existed. They record what
CRuby actually exposes, what was verified empirically, and which decisions in
the collector follow from that. Line numbers refer to the tagged CRuby
sources (`v3_2_5`, `v3_3_0`, `v3_4_8`, and the `4.0.0` release revision).

## 1. What CRuby gives us directly

Since Ruby 3.2 (ruby/ruby#5500) the public header `ruby/thread.h` exposes a
thread instrumentation API:

```c
rb_internal_thread_event_hook_t *
rb_internal_thread_add_event_hook(rb_internal_thread_event_callback func,
                                  rb_event_flag_t events, void *data);
bool rb_internal_thread_remove_event_hook(rb_internal_thread_event_hook_t *hook);
```

with five events:

| Constant                                | Meaning (from the header)      |
|-----------------------------------------|--------------------------------|
| `RUBY_INTERNAL_THREAD_EVENT_STARTED`    | thread started                 |
| `RUBY_INTERNAL_THREAD_EVENT_READY`      | acquiring GVL                  |
| `RUBY_INTERNAL_THREAD_EVENT_RESUMED`    | acquired GVL                   |
| `RUBY_INTERNAL_THREAD_EVENT_SUSPENDED`  | released GVL                   |
| `RUBY_INTERNAL_THREAD_EVENT_EXITED`     | thread terminated              |

The hooks live in `thread_pthread.c`, so they are a no-op on Windows and
WebAssembly. Registration takes a `pthread_rwlock` write lock; every event
dispatch takes the read lock and walks a linked list of hooks
(`rb_thread_execute_hooks`). Two consequences:

- `rb_internal_thread_add_event_hook` / `remove` must never be called from a
  callback (the header says so; it would self-deadlock on the rwlock).
- The read lock is held while our callback runs. Anything slow in the
  callback delays every scheduler transition in the process.

The events are emitted with `RB_INTERNAL_THREAD_HOOK(...)` from inside the
thread scheduler. They are the scheduler's own transitions, not an
approximation of them, which is exactly why this project uses them.

## 2. Where each event fires, and what lock the caller holds

### Ruby 3.2 (`thread_pthread.c`, 1:1 scheduler)

| Event      | Call site                                          | Lock state when the callback runs                        |
|------------|----------------------------------------------------|----------------------------------------------------------|
| READY      | `thread_sched_to_running_common` (line 383)        | **`sched->lock` held** (the GVL mutex itself), no GVL   |
| RESUMED    | `thread_sched_to_running_common` (line 415)        | **`sched->lock` held**, `sched->running == th`           |
| SUSPENDED  | `thread_sched_to_waiting` (446), `native_sleep` (2337) | no lock, no GVL                                      |
| STARTED    | `thread_start_func_1` (1166), on the new native thread | no GVL                                               |
| EXITED     | `thread_start_func_1` (1175), on the exiting native thread | no GVL                                           |

`event_data` is `NULL` in 3.2 (`typedef void rb_internal_thread_event_data_t`).
The only way to know *which* Ruby thread an event is about is that in 3.2 all
five call sites execute on the native thread that belongs to the Ruby thread,
so a `_Thread_local` variable identifies it.

3.2 also has `USE_THREAD_CACHE`: a native thread whose Ruby thread finished
parks for a while and may be reused by the next `Thread.new`. A new Ruby
thread on a cached native thread still gets a STARTED event, so the
thread-local identity must be reset on STARTED, and a native thread id must
never be treated as a Ruby thread id even on 3.2.

### Ruby 3.3, 3.4 and 4.0 (`thread_pthread.c` + `thread_pthread_mn.c`, M:N capable)

| Event      | Call sites                                                                                  | Native thread running the callback |
|------------|---------------------------------------------------------------------------------------------|------------------------------------|
| STARTED    | `native_thread_create` (3.4: 2333)                                                          | the **creating** thread            |
| READY      | `thread_sched_to_ready_common` (3.4: 806)                                                   | whoever made the thread ready: itself, a waker, or the timer thread |
| RESUMED    | `thread_sched_wait_running_turn` (3.4: 909), `co_start` in `thread_pthread_mn.c` (452)      | the thread itself                  |
| SUSPENDED  | `thread_sched_to_waiting_common0` (991), `thread_sched_to_waiting_until_wakeup` (1091), `thread_sched_yield` (1119), `ractor_sched_sleep` (1338), `thread_sched_wait_events` (mn.c 77) | the thread itself |
| EXITED     | `thread_sched_to_dead_common` (1007)                                                         | the thread itself                  |

All of them are called with the scheduler lock (`thread_sched_lock`) held or
about to be taken, so the same "do not block" rule applies.

`event_data->thread` carries the `VALUE` of the Ruby thread since 3.3, and
the header is explicit: *"Callbacks are not guaranteed to be executed on the
native threads that corresponds to the Ruby thread. To identify which Ruby
thread the event refers to, you must use `event_data->thread`."*

The header also documents GVL state: RESUMED is delivered *with* the GVL
held; the other four *without*. Note that "without the GVL" does not mean
"nobody holds it": for STARTED the creator is holding it, and for READY the
waker may be.

### Verified empirically

A throwaway extension recorded every event with `CLOCK_MONOTONIC`, `gettid()`
and a per-thread serial, for the two-thread CPU + `sleep 0.2` program in
`examples/cpu_threads.rb`.

Ruby 3.2.5:

```
     0.000 ms  T1  tid=283611  TRACE_START
     0.096 ms  T1  tid=283611  SUSPENDED      main enters Thread#join
     0.288 ms  T2  tid=283696  STARTED        on T2's own native thread
     0.290 ms  T2  tid=283696  READY
     0.290 ms  T2  tid=283696  RESUMED
     0.343 ms  T3  tid=283695  STARTED
     0.345 ms  T3  tid=283695  READY
   100.500 ms  T3  tid=283695  RESUMED        100 ms timeslice expired
   100.582 ms  T2  tid=283696  READY          T2 was preempted: no SUSPENDED
   200.612 ms  T2  tid=283696  RESUMED
   200.619 ms  T3  tid=283695  READY
   294.096 ms  T2  tid=283696  SUSPENDED      sleep 0.2 ...
   294.097 ms  T2  tid=283696  SUSPENDED      ... emitted twice (see below)
   294.230 ms  T3  tid=283695  RESUMED
   494.169 ms  T2  tid=283696  READY          sleep over
   494.170 ms  T2  tid=283696  RESUMED
   677.753 ms  T2  tid=283696  SUSPENDED
   677.755 ms  T2  tid=283696  EXITED
   875.095 ms  T1  tid=283611  READY
   875.096 ms  T1  tid=283611  RESUMED
```

Ruby 3.4.8 (identical shape on 3.3.0 and 4.0.0):

```
     0.000 ms  T1  tid=283861  TRACE_START
     0.021 ms  T2  tid=283861  STARTED        callback ran on MAIN's native thread
     0.090 ms  T2  tid=283861  READY          same
     0.099 ms  T3  tid=283861  STARTED
     0.140 ms  T3  tid=283861  READY
     0.144 ms  T1  tid=283861  SUSPENDED
     0.247 ms  T2  tid=283946  RESUMED        first time we see T2's real native thread
   101.799 ms  T2  tid=283946  SUSPENDED      timeslice: SUSPENDED then READY
   101.802 ms  T2  tid=283946  READY
   101.913 ms  T3  tid=283947  RESUMED
   471.382 ms  T2  tid=283946  SUSPENDED      sleep 0.2, emitted once
   671.582 ms  T2  tid=283946  READY
   671.585 ms  T2  tid=283946  RESUMED
  1150.768 ms  T1  tid=283946  READY          main made READY by T2 (join wakeup)
  1150.773 ms  T2  tid=283946  SUSPENDED
  1150.775 ms  T2  tid=283946  EXITED
  1207.192 ms  T1  tid=283861  RESUMED
```

Ruby 3.4.8 with `RUBY_MN_THREADS=1`:

```
     0.217 ms  T2  tid=285098  RESUMED
   101.865 ms  T3  tid=285098  RESUMED        T3 runs on the same native thread as T2
   203.675 ms  T2  tid=285098  RESUMED
```

Findings that shape the design:

1. **A preemption on 3.2 has no SUSPENDED.** The thread that lost its
   timeslice reports READY directly from the running state. The state
   machine must accept RUNNING → WANTS_GVL, and the previous owner's running
   interval must be closed by *another thread's* RESUMED.
2. **3.2 emits SUSPENDED twice for `Kernel#sleep`** (once in
   `thread_sched_to_waiting`, once in `native_sleep`). We record both and
   let the model treat a repeated SUSPENDED as a no-op transition, instead
   of dropping it in the callback.
3. **On 3.3+ the native thread id captured in the callback is the callback
   runner's, not necessarily the Ruby thread's.** Only RESUMED, SUSPENDED
   and EXITED are guaranteed to run on the thread's own native thread. The
   protocol therefore carries `native_thread_id` with the meaning "native
   thread that executed the hook", and the *derived* "native thread this
   Ruby thread runs on" is taken from RESUMED events.
4. **M:N is real.** With `RUBY_MN_THREADS=1` several Ruby threads share one
   native thread. Native thread id is not an identity for a Ruby thread.
5. `ruby_thread_has_gvl_p()` is exported by libruby on every version we
   target but only declared in the public header from 4.0. Its answer inside
   these callbacks is not what a reader would expect (on 3.2 it reports
   `true` for a READY thread that does not yet own the lock), so the
   recorder does not use it.

## 3. What data is available in `event_data`

| Version | `event_data`               | Usable content |
|---------|----------------------------|----------------|
| 3.2     | `NULL`                     | nothing        |
| 3.3+    | `struct { VALUE thread; }` | the thread `VALUE` |

Nothing else: no ractor, no native thread, no reason for the transition.
Anything beyond "thread X did transition Y at time T" is derived.

## 4. Maintaining Ruby thread identity without calling Ruby

### 3.3+

`rb_internal_thread_specific_key_create` gives up to
`RB_INTERNAL_THREAD_SPECIFIC_KEY_MAX` (8) per-thread `void *` slots, and
`rb_internal_thread_specific_get/set` are documented as async-signal-safe
and thread-safe. Looking at `thread.c` they are a plain array read/write on
`rb_thread_t`, which is why they are safe from a callback without the GVL.

Constraint: the first `key_create` in the process must happen while only one
ractor exists, otherwise CRuby raises. We create the key at extension load.

The value stored in the slot is a pointer into a preallocated pool of
`rv_thread_state` structs, handed out with an atomic bump index. The pool is
allocated with `calloc` when tracing starts (with the GVL) so the callbacks
never allocate. If the pool is exhausted the thread is recorded with serial
`0` and a counter is incremented; the trace reports it.

### 3.2

There is no per-thread slot and `event_data` is `NULL`. Because 3.2 runs a
1:1 scheduler and all five hooks run on the thread's own native thread, a
`_Thread_local rv_thread_state` is correct. STARTED resets it (thread cache
reuse). The main thread never receives STARTED so it is registered when
tracing starts. Ruby-side mapping from `Thread` objects to serials uses
`Thread#native_thread_id`, which is valid on 3.2 precisely because the
mapping is 1:1 there.

## 5. Capturing native thread identity

`gettid(2)` on Linux (glibc ≥ 2.30 has a wrapper; we fall back to
`syscall(SYS_gettid)`). The id is cached in a `_Thread_local` so the
syscall runs once per native thread, not once per event. This is correct
under M:N because thread-local storage belongs to the native thread.

macOS would need `pthread_threadid_np`; not targeted in milestone 1.

## 6. Version differences that matter

| Concern                              | 3.2                       | 3.3 / 3.4 / 4.0                           |
|--------------------------------------|---------------------------|-------------------------------------------|
| `event_data`                         | `NULL`                    | `{ VALUE thread }`                        |
| Per-thread native storage            | none (use TLS)            | `rb_internal_thread_specific_*`           |
| Callback thread == Ruby thread's     | always                    | only RESUMED / SUSPENDED / EXITED         |
| STARTED runs on                      | the new thread            | the creating thread                       |
| Timeslice preemption                 | READY only                | SUSPENDED + READY                         |
| `Kernel#sleep`                       | two SUSPENDED             | one SUSPENDED                             |
| Scheduler                            | 1:1, per-process lock     | per-ractor `rb_thread_sched`, optional M:N |
| Lock held during READY/RESUMED       | `sched->lock`             | `thread_sched_lock`                       |

## 7. M:N implications

In 3.3+ `struct rb_thread_sched` lives per ractor (`TH_SCHED(th)` resolves
through `th->ractor`). The "GVL" is therefore a per-ractor lock, and with
`RUBY_MN_THREADS=1` (or always for non-main ractors) Ruby threads are
coroutines moved between a pool of native threads.

For this project:

- A Ruby thread is identified by a serial that we assign; the native thread
  is a separate, time-varying attribute.
- The invariant "at most one RUNNING thread" holds *per ractor*, not per
  process. The event protocol reserves `ractor_id` for this reason. In
  milestone 1 the recorder cannot read the ractor from the callback (it is
  not in `event_data`), so it reports the field as unknown unless the
  process had a single ractor, in which case it is derived.

## 8. What gvl-tracing already solves

`ivoanjo/gvl-tracing` (MIT) was studied in depth. It:

- subscribes to the same five events plus `RUBY_INTERNAL_EVENT_GC_ENTER/EXIT`
  through a tracepoint;
- chooses TLS state on 3.2 and `rb_internal_thread_specific_*` on 3.3+;
- allocates its per-thread state lazily on STARTED/RESUMED, treating those
  two as GVL-holding;
- coalesces back-to-back SUSPENDED events;
- detects `Kernel#sleep` by calling `rb_frame_method_id_and_class` from the
  SUSPENDED callback;
- writes Chrome Trace Event JSON with `fprintf` from inside the callback;
- offers an experimental OS-thread view by emitting a second fake process.

Concepts we keep: the event set, the two identity strategies, GC events via
tracepoint, the observation that the native thread view is a separate view.

Things we do differently, and why:

- **No I/O and no formatting in the callback.** `fprintf` from a hook that
  holds the scheduler lock serialises every thread switch behind a `FILE*`
  lock. We write a fixed-size struct into a lock-free ring buffer and
  serialise later, with the GVL, on the Ruby side.
- **No Ruby calls from SUSPENDED.** `rb_frame_method_id_and_class` and
  `Thread#alive?` inspect the execution context without the GVL. It works
  in practice but it is exactly the class of thing we promised not to do.
  Sleep is instead observed with a Ruby-level probe that runs with the GVL
  and is correlated afterwards; it is marked as a different source.
- **No coalescing in the callback.** We record what CRuby emitted; the
  model decides what a repeated SUSPENDED means.
- **Explicit drop accounting.** A full buffer produces an `events_dropped`
  record; nothing is lost silently.
- **Our own protocol.** Perfetto is an exporter, not the data model.
- **Native thread id is a per-event attribute**, with the "callback ran on
  another thread" caveat encoded in the protocol instead of assumed away.

## 9. Risks

- **The API is documented as internal/experimental.** It changed shape
  between 3.2 and 3.3 and may again. The extension isolates every
  version-specific decision behind `HAVE_RB_INTERNAL_THREAD_SPECIFIC_GET`.
- **Callbacks run while the scheduler lock is held.** A blocking or slow
  callback stalls every thread switch. The ring buffer never blocks; on
  overflow it drops and counts.
- **`RUBY_INTERNAL_EVENT_GC_ENTER/EXIT` tracepoints run inside the GC.**
  Allocating Ruby objects there is forbidden; we only write to the ring.
- **Fork.** The hook list and our buffer are inherited by the child. The
  Ruby layer re-arms after fork via `Process._fork` on 3.1+, and the trace
  records the pid on every header so a mixed trace cannot be misread.
- **Overhead is not zero.** Each event costs a monotonic clock read, an
  atomic reservation and a 64-byte store. The recorder reports how many
  events it recorded and over what duration so the reader can judge it.
- **Line-level tracing perturbs scheduling.** `TracePoint(:line)` keeps
  the GVL busier and changes when timeslices expire. It is off by default
  and its cost is measured in `docs/tracing-overhead.md`.
