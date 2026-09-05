// Thread state intervals and GVL ownership, following docs/event-protocol.md
// ("Thread state model" and "GVL ownership lane"). This is a port of the
// reference implementation in lib/runtime_visualizer/timeline.rb and must
// produce the same segments for the same input.

import { isProbeEvent, isSchedulerEvent, type Precision, type Trace, type TraceEvent } from "../protocol/types";

export type ThreadState =
  | "STARTED"
  | "WANTS_GVL"
  | "RUNNING"
  | "SUSPENDED"
  | "PREEMPTED"
  | "SLEEPING"
  | "WAITING_MUTEX"
  | "EXITED"
  | "UNKNOWN";

export const THREAD_STATES: readonly ThreadState[] = [
  "STARTED",
  "WANTS_GVL",
  "RUNNING",
  "SUSPENDED",
  "PREEMPTED",
  "SLEEPING",
  "WAITING_MUTEX",
  "EXITED",
  "UNKNOWN",
];

/** Which probe boundaries a derived SUSPENDED relabel came from. */
export interface ProbeWindow {
  state: "SLEEPING" | "WAITING_MUTEX";
  startNs: number;
  endNs: number;
  enterSequence: number;
  exitSequence: number;
}

export interface Segment {
  rubyThreadId: number;
  state: ThreadState;
  startNs: number;
  endNs: number;
  precision: Precision;
  nativeEvent: string | null;
  /** Sequence of the event that opened the segment; 0 for inferred initial states. */
  sequence: number;
  /** For PREEMPTED: the thread whose gvl_acquired closed this thread's RUNNING. */
  preemptedBy?: number;
  /** For SLEEPING / WAITING_MUTEX: the probe window that relabelled a SUSPENDED. */
  derivedFrom?: ProbeWindow;
}

export interface GvlSegment {
  /** null means the GVL was idle. */
  owner: number | null;
  startNs: number;
  endNs: number;
  precision: Precision;
  /** Sequence of the event that opened this segment; 0 at the start of the trace. */
  sequence: number;
}

export interface Violation {
  sequence: number;
  rubyThreadId: number;
  message: string;
}

export interface Timeline {
  threadSegments: Map<number, Segment[]>;
  gvlSegments: GvlSegment[];
  violations: Violation[];
}

const TRANSITIONS: Record<string, ThreadState> = {
  thread_started: "STARTED",
  wants_gvl: "WANTS_GVL",
  gvl_acquired: "RUNNING",
  gvl_released: "SUSPENDED",
  thread_exited: "EXITED",
};

interface OpenSegment {
  state: ThreadState;
  startNs: number;
  precision: Precision;
  nativeEvent: string | null;
  sequence: number;
  preemptedBy?: number;
}

export function buildTimeline(trace: Trace): Timeline {
  const threadSegments = new Map<number, Segment[]>();
  const gvlSegments: GvlSegment[] = [];
  const violations: Violation[] = [];
  const open = new Map<number, OpenSegment>();
  let gvlOwner: number | null = null;
  let gvlSince = trace.startNs;
  let gvlSequence = 0;

  const close = (id: number, endNs: number): void => {
    const current = open.get(id);
    if (!current) return;
    open.delete(id);
    if (current.state === "UNKNOWN" && current.startNs === endNs) return;
    const segment: Segment = {
      rubyThreadId: id,
      state: current.state,
      startNs: current.startNs,
      endNs,
      precision: current.precision,
      nativeEvent: current.nativeEvent,
      sequence: current.sequence,
    };
    if (current.preemptedBy !== undefined) segment.preemptedBy = current.preemptedBy;
    segmentsFor(threadSegments, id).push(segment);
  };

  const closeGvl = (untilNs: number): void => {
    if (untilNs <= gvlSince) return;
    gvlSegments.push({
      owner: gvlOwner,
      startNs: gvlSince,
      endNs: untilNs,
      precision: gvlOwner === null ? "derived" : "observed",
      sequence: gvlSequence,
    });
  };

  const transition = (id: number, state: ThreadState, event: TraceEvent): void => {
    const current = open.get(id);
    // A repeated identical transition (3.2 emits SUSPENDED twice for sleep)
    // does not open a new segment.
    if (current && current.state === state && current.precision === "observed") return;
    close(id, event.timestamp_ns);
    open.set(id, {
      state,
      startNs: event.timestamp_ns,
      precision: "observed",
      nativeEvent: event.native_event,
      sequence: event.sequence,
    });
  };

  for (const event of trace.events) {
    const id = event.ruby_thread_id;
    if (id === 0) continue;

    if (event.type === "tracing_started") {
      // The thread that started tracing held the GVL to do so.
      open.set(id, {
        state: "RUNNING",
        startNs: event.timestamp_ns,
        precision: "observed",
        nativeEvent: null,
        sequence: event.sequence,
      });
      gvlOwner = id;
      gvlSince = event.timestamp_ns;
      gvlSequence = event.sequence;
      continue;
    }
    if (!isSchedulerEvent(event.type)) continue;

    const state = TRANSITIONS[event.type];
    if (!state) continue;
    if (!open.has(id)) {
      const initial = inferInitial(event, trace.startNs);
      if (initial) open.set(id, initial);
    }

    if (event.type === "gvl_acquired") {
      if (gvlOwner !== null && gvlOwner !== id) {
        // Another thread got the lock without this owner reporting a
        // release: 3.2 timeslice preemption looks like this. Close the
        // owner's segment and mark the gap until it speaks again.
        close(gvlOwner, event.timestamp_ns);
        open.set(gvlOwner, {
          state: "PREEMPTED",
          startNs: event.timestamp_ns,
          precision: "derived",
          nativeEvent: null,
          sequence: event.sequence,
          preemptedBy: id,
        });
      } else if (gvlOwner === id) {
        violations.push({ sequence: event.sequence, rubyThreadId: id, message: "gvl_acquired while already the owner" });
      }
      closeGvl(event.timestamp_ns);
      gvlOwner = id;
      gvlSince = event.timestamp_ns;
      gvlSequence = event.sequence;
    } else if (event.type === "gvl_released" || event.type === "thread_exited") {
      if (gvlOwner === id) {
        closeGvl(event.timestamp_ns);
        gvlOwner = null;
        gvlSince = event.timestamp_ns;
        gvlSequence = event.sequence;
      }
    }

    transition(id, state, event);
  }

  for (const id of Array.from(open.keys())) close(id, trace.endNs);
  closeGvl(trace.endNs);
  relabelWithProbes(trace, threadSegments);
  for (const segments of threadSegments.values()) segments.sort((a, b) => a.startNs - b.startNs);

  return { threadSegments, gvlSegments, violations };
}

function segmentsFor(map: Map<number, Segment[]>, id: number): Segment[] {
  let list = map.get(id);
  if (!list) {
    list = [];
    map.set(id, list);
  }
  return list;
}

// A thread whose first event is not thread_started was alive before the
// trace began. Its state until then is a guess, and labelled as such.
function inferInitial(event: TraceEvent, traceStartNs: number): OpenSegment | null {
  let state: ThreadState;
  switch (event.type) {
    case "thread_started":
      return null;
    case "gvl_released":
      state = "RUNNING";
      break;
    case "wants_gvl":
      state = "SUSPENDED";
      break;
    default:
      state = "UNKNOWN";
  }
  return { state, startNs: traceStartNs, precision: "inferred", nativeEvent: null, sequence: 0 };
}

// SUSPENDED intervals enclosed by probe boundaries on the same thread get a
// reason. Everything else keeps the honest "SUSPENDED, reason unknown".
function relabelWithProbes(trace: Trace, threadSegments: Map<number, Segment[]>): void {
  const windows = probeWindows(trace);
  for (const [id, segments] of threadSegments) {
    const threadWindows = windows.get(id);
    if (!threadWindows) continue;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (!segment || segment.state !== "SUSPENDED") continue;
      const window = threadWindows.find((w) => w.startNs <= segment.startNs && segment.endNs <= w.endNs);
      if (window) segments[i] = { ...segment, state: window.state, precision: "derived", derivedFrom: window };
    }
  }
}

function probeWindows(trace: Trace): Map<number, ProbeWindow[]> {
  const windows = new Map<number, ProbeWindow[]>();
  const pending = new Map<string, TraceEvent>();
  const closeWindow = (event: TraceEvent, kind: string, state: ProbeWindow["state"]): void => {
    const key = `${event.ruby_thread_id}:${kind}`;
    const enter = pending.get(key);
    if (!enter) return;
    pending.delete(key);
    let list = windows.get(event.ruby_thread_id);
    if (!list) {
      list = [];
      windows.set(event.ruby_thread_id, list);
    }
    list.push({
      state,
      startNs: enter.timestamp_ns,
      endNs: event.timestamp_ns,
      enterSequence: enter.sequence,
      exitSequence: event.sequence,
    });
  };

  for (const event of trace.events) {
    if (!isProbeEvent(event.type)) continue;
    switch (event.type) {
      case "sleep_enter":
        pending.set(`${event.ruby_thread_id}:sleep`, event);
        break;
      case "sleep_exit":
        closeWindow(event, "sleep", "SLEEPING");
        break;
      case "mutex_lock_wait":
        pending.set(`${event.ruby_thread_id}:mutex`, event);
        break;
      case "mutex_acquired":
        closeWindow(event, "mutex", "WAITING_MUTEX");
        break;
      case "mutex_released":
        break;
    }
  }
  return windows;
}

/** Index of the last segment starting at or before `ns`, or -1. */
function lastStartingBefore(segments: readonly { startNs: number }[], ns: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const segment = segments[mid];
    if (segment && segment.startNs <= ns) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function segmentAt(segments: readonly Segment[], ns: number): Segment | null {
  // Segments on one lane are ordered and non-overlapping, so the candidate is
  // the last one starting at or before the cursor.
  const index = lastStartingBefore(segments, ns);
  const segment = index === -1 ? undefined : segments[index];
  return segment && ns < segment.endNs ? segment : null;
}

export function gvlSegmentAt(segments: readonly GvlSegment[], ns: number): GvlSegment | null {
  const index = lastStartingBefore(segments, ns);
  const segment = index === -1 ? undefined : segments[index];
  return segment && ns < segment.endNs ? segment : null;
}
