# Controlled execution: design notes

Status: research only. Nothing in this document is implemented.

The replay mode records a program that ran on its own and lets you move
through what happened. A controlled mode would let you *pause a running
program at a thread switch and step it*. This page works out how that
could be done without crashing the interpreter, and what it would cost
in fidelity.

## Why the scheduler hooks cannot be the mechanism

It is tempting to block inside the `RESUMED` callback: the thread has the
GVL, "just wait on a condition variable until the user clicks Step".
This is unsafe for several independent reasons:

1. **The scheduler lock is held.** `RESUMED` fires from
   `thread_sched_wait_running_turn` on 3.3+ and from
   `thread_sched_to_running_common` on 3.2, both while the scheduler's
   mutex is held. Blocking there blocks every other thread's attempt to
   acquire or release the GVL, including the thread that would deliver
   the "continue" signal.
2. **The hook rwlock is held.** `rb_thread_execute_hooks` holds a read
   lock while calling us. `rb_internal_thread_remove_event_hook` needs
   the write lock. Blocking in a hook makes stopping the recorder
   deadlock.
3. **No GVL in four of the five events.** `READY`, `SUSPENDED`,
   `STARTED`, `EXITED` run without the GVL; nothing Ruby-level can be
   done from there, including signalling a Ruby-level UI.
4. **Interrupts do not reach a native wait.** `Thread#kill`, `Ctrl-C` and
   timeouts are delivered through `RUBY_VM_CHECK_INTS`, which the thread
   only reaches when it returns to Ruby code.
5. **M:N.** On a shared native thread, blocking the native thread blocks
   every Ruby thread scheduled on it.

Any design that blocks inside `rb_internal_thread_add_event_hook`
callbacks is out.

## A cooperative checkpoint design

The safe place to pause a thread is *while it owns the GVL and is
executing Ruby code*, at a point where CRuby expects Ruby-level blocking
to be possible. That is a TracePoint callback or a probe.

```
                       ┌──────────── controller (own thread) ────────────┐
                       │  wants: pause / step / continue                 │
                       │  holds: a Mutex + ConditionVariable per target  │
                       └───────────────▲────────────────────┬────────────┘
                                       │ status              │ commands
      target thread                    │                     ▼
      ── Ruby line ── TracePoint(:line) ── checkpoint(): if paused → cv.wait
```

- **Checkpoint sites.** `TracePoint(:line)` (every line), or
  `TracePoint(:call, :return)` (coarser), or only inside the probes
  (`sleep`, `Mutex#lock`). The checkpoint runs with the GVL and can call
  `ConditionVariable#wait`, which releases the GVL correctly through
  `rb_mutex_sleep` and honours interrupts.
- **Stepping.** "Step" releases one checkpoint. "Step to next thread
  switch" releases the current thread until the recorder observes a
  `SUSPENDED` for it, then pauses whichever thread reports `RESUMED`
  next *at its next checkpoint*.
- **Signalling from the hook side.** The scheduler hooks still run
  unsafely; they only write to the ring. A controller thread drains the
  ring and decides. Latency between the scheduler event and the pause is
  therefore "until the target's next checkpoint".

### What this perturbs

- Every checkpoint is a TracePoint callback: the same 25x–140x slowdown
  as `--lines`, before any pausing.
- A paused thread holds no lock but also cannot be preempted by the
  timeslice: it is *sleeping* from CRuby's point of view. Other threads
  run while it is paused; the observed schedule is the controller's
  schedule.
- Pausing inside `Mutex#synchronize` keeps the mutex held. Any thread
  waiting on it waits for the user.

### Deadlocks and how to avoid them

| Situation | Risk | Rule |
|-----------|------|------|
| Controller pauses thread A inside a `Mutex#synchronize`; main thread joins A | main blocks in `join` until the user continues | Never auto-pause; show the mutex ownership in the UI; offer "continue all". |
| All threads paused, controller itself needs the GVL | none: controller is a Ruby thread blocking on IO; CRuby's deadlock detector may raise `fatal` "No live threads left" if every thread is in `cv.wait` and the controller is also waiting | Controller must never block in `cv.wait`; it blocks on a socket/pipe (IO waits are not counted as deadlock). |
| Pause requested while a thread is in a blocking region (`SUSPENDED`) | the thread cannot check anything until it returns | Pause takes effect at the next checkpoint; the UI shows "pause pending". |
| Fork while paused | child inherits mutexes/cvs in an unusable state | Refuse controlled mode across fork, or disarm in the child. |
| `Thread#kill` of a paused thread | `cv.wait` is interruptible; the ensure must release the mutex | Use `Mutex#synchronize` around the wait so unwinding is correct. |
| Ractors | a checkpoint in a non-main ractor cannot share the controller's objects | Milestone 1 rule: controlled mode only in the main ractor. |

### Alternative: the debugger APIs

`debug.gem` (ruby/debug) has solved thread-aware stepping: it stops all
threads at a breakpoint using `Thread#stop`-like coordination through
its own TracePoints, and it exposes an IPC protocol (DAP / CDP). Two ways
to use it:

1. Run the target under `rdbg` and drive it through DAP, while the
   recorder runs in the same process; correlate the recorder's timeline
   with the debugger's stop events by thread id.
2. Reuse `DEBUGGER__`'s thread-stop machinery directly as the checkpoint
   implementation.

Option 1 keeps our code out of the debugger's very sensitive parts and
gives breakpoints, step-in/out, and variable inspection for free; the
price is a second protocol to speak. It is the preferred path.

### The honest UI text

Any controlled mode must display, in the same place as "TRACE MODE":

> CONTROLLED MODE — Execution is being intentionally synchronized by
> Runtime Visualizer. Observed scheduling is no longer natural scheduling.

and the trace header must record `"controlled": true` and the checkpoint
granularity, so a controlled trace is never mistaken for a natural one.

## Summary

- Do not block in scheduler hooks. Ever.
- Pause at Ruby-level checkpoints with the GVL held, using a Mutex and a
  ConditionVariable; the controller blocks on IO, not on a cv.
- Prefer driving `ruby/debug` over DAP to writing a second debugger.
- Label the trace and the UI as controlled, and expect the schedule to be
  an artefact of the controller.
