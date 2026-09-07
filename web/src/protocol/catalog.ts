// What each event and state means, in CRuby terms. The wording follows
// docs/event-protocol.md so the inspector never says more than the spec does.

import type { NativeThreadRole, Precision } from "./types";

export interface EventMeaning {
  channel: string;
  /** The CRuby constant, tracepoint or method the event came from. */
  nativeEvent: string | null;
  meaning: string;
}

export const EVENT_MEANINGS: Record<string, EventMeaning> = {
  thread_started: {
    channel: "cruby_internal_thread_event",
    nativeEvent: "RUBY_INTERNAL_THREAD_EVENT_STARTED",
    meaning:
      "A native thread is being created for this Ruby thread (3.3+: called by the creator; 3.2: called on the new thread). The thread has not run Ruby code yet.",
  },
  wants_gvl: {
    channel: "cruby_internal_thread_event",
    nativeEvent: "RUBY_INTERNAL_THREAD_EVENT_READY",
    meaning:
      "The thread was put on the ready queue of its scheduler. It wants the lock. It may already own it if the queue was empty.",
  },
  gvl_acquired: {
    channel: "cruby_internal_thread_event",
    nativeEvent: "RUBY_INTERNAL_THREAD_EVENT_RESUMED",
    meaning: "sched->running == th; the thread owns the VM lock and is about to run Ruby code.",
  },
  gvl_released: {
    channel: "cruby_internal_thread_event",
    nativeEvent: "RUBY_INTERNAL_THREAD_EVENT_SUSPENDED",
    meaning:
      "The thread is giving up the lock: blocking region, sleep, yield, exit, or waiting on a condition. CRuby does not say which.",
  },
  thread_exited: {
    channel: "cruby_internal_thread_event",
    nativeEvent: "RUBY_INTERNAL_THREAD_EVENT_EXITED",
    meaning: "The Ruby thread finished.",
  },
  gc_enter: {
    channel: "cruby_gc_tracepoint",
    nativeEvent: "RUBY_INTERNAL_EVENT_GC_ENTER",
    meaning: "GC started. ruby_thread_id is the thread that was running; it owns the GVL during GC.",
  },
  gc_exit: {
    channel: "cruby_gc_tracepoint",
    nativeEvent: "RUBY_INTERNAL_EVENT_GC_EXIT",
    meaning: "GC finished on the thread that owned the GVL.",
  },
  sleep_enter: {
    channel: "probe:sleep",
    nativeEvent: "Kernel#sleep",
    meaning:
      "Kernel#sleep was called. The call was observed by a module prepended to Kernel (it runs with the GVL), not the scheduler's reason for suspending.",
  },
  sleep_exit: {
    channel: "probe:sleep",
    nativeEvent: "Kernel#sleep",
    meaning: "Kernel#sleep returned on this thread.",
  },
  mutex_lock_wait: {
    channel: "probe:mutex",
    nativeEvent: "Thread::Mutex#lock",
    meaning:
      "Thread::Mutex#lock was called. A gvl_released between this and mutex_acquired is derived to be waiting for the mutex; CRuby's thread hooks do not say that.",
  },
  mutex_acquired: {
    channel: "probe:mutex",
    nativeEvent: "Thread::Mutex#lock",
    meaning: "Thread::Mutex#lock returned; this thread holds the mutex.",
  },
  mutex_released: {
    channel: "probe:mutex",
    nativeEvent: "Thread::Mutex#unlock",
    meaning: "Thread::Mutex#unlock was called on this thread.",
  },
  source_line: {
    channel: "tracepoint:line",
    nativeEvent: "TracePoint :line",
    meaning: "The thread is about to execute a new source line (high overhead channel).",
  },
  tracing_started: {
    channel: "recorder",
    nativeEvent: null,
    meaning: "The recorder started. The thread that started tracing held the GVL to do so.",
  },
  tracing_stopped: {
    channel: "recorder",
    nativeEvent: null,
    meaning: "The recorder stopped; nothing after this point was observed.",
  },
  events_dropped: {
    channel: "recorder",
    nativeEvent: null,
    meaning:
      "The ring buffer rejected events since the previous drain. The timestamp is the drain time, not the time of the first drop; the drops happened somewhere in the preceding gap.",
  },
  threads_unidentified: {
    channel: "recorder",
    nativeEvent: null,
    meaning: "Events could not be attributed to a thread (metadata.count).",
  },
};

export const NATIVE_THREAD_ROLE_MEANINGS: Record<NativeThreadRole, string> = {
  self: "The callback ran on the Ruby thread's own native thread.",
  creator: "The callback ran on the thread that called Thread.new (STARTED on 3.3+).",
  unknown: "Could be the thread itself, a waker, or the timer thread (READY on 3.3+).",
};

export const PRECISION_MEANINGS: Record<Precision, string> = {
  observed:
    "The runtime (or a probe running under the GVL) reported this fact directly. The timestamp is the moment the callback ran.",
  derived: "Computed from observed events by a deterministic rule.",
  inferred: "A best guess that could be wrong.",
};

export const STATE_MEANINGS: Record<string, string> = {
  STARTED: "thread_started was seen. A native thread exists but no Ruby code has run yet.",
  WANTS_GVL: "On the ready queue of its scheduler, waiting for the VM lock.",
  RUNNING: "Owns the VM lock (sched->running == th) and may execute Ruby code.",
  SUSPENDED: "Gave up the VM lock. CRuby does not say why: blocking region, sleep, yield, or a condition wait.",
  PREEMPTED:
    "Another thread acquired the VM lock while this one had not reported a release. CRuby moved on without telling this thread (3.2 timeslice preemption looks like this).",
  SLEEPING: "A SUSPENDED interval that falls between sleep_enter and sleep_exit on the same thread.",
  WAITING_MUTEX: "A SUSPENDED interval that falls between mutex_lock_wait and mutex_acquired on the same thread.",
  EXITED: "The Ruby thread finished.",
  UNKNOWN: "The thread was alive before the trace began and its first event does not reveal its state.",
};

export const TRACE_MODE_NOTICE =
  "Program scheduling was not intentionally controlled by Runtime Visualizer. Instrumentation overhead still exists.";
