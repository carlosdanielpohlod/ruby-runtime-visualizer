// Lanes keyed by native thread id. Only RUNNING is placed here: it is the one
// state whose native thread is certain, because gvl_acquired runs on the
// thread that now owns the lock (native_thread_role "self"). Every other
// callback may run on a waker, the creator or the timer thread.

import type { Trace } from "../protocol/types";
import type { Segment, Timeline } from "./timeline";

export interface NativeLane {
  nativeThreadId: number;
  /** Ruby threads that ran on this native thread, in order of first appearance. */
  rubyThreadIds: number[];
  /** RUNNING segments only, ordered by start. */
  segments: Segment[];
}

export function buildNativeLanes(trace: Trace, timeline: Timeline): NativeLane[] {
  const eventsBySequence = new Map<number, number | null>();
  for (const event of trace.events) eventsBySequence.set(event.sequence, event.native_thread_id);

  const lanes = new Map<number, NativeLane>();
  const laneFor = (nativeThreadId: number): NativeLane => {
    let lane = lanes.get(nativeThreadId);
    if (!lane) {
      lane = { nativeThreadId, rubyThreadIds: [], segments: [] };
      lanes.set(nativeThreadId, lane);
    }
    return lane;
  };

  for (const [rubyThreadId, segments] of timeline.threadSegments) {
    for (const segment of segments) {
      if (segment.state !== "RUNNING") continue;
      const nativeId = nativeThreadFor(trace, rubyThreadId, segment, eventsBySequence);
      if (nativeId === null) continue;
      const lane = laneFor(nativeId);
      lane.segments.push(segment);
      if (!lane.rubyThreadIds.includes(rubyThreadId)) lane.rubyThreadIds.push(rubyThreadId);
    }
  }

  for (const lane of lanes.values()) lane.segments.sort((a, b) => a.startNs - b.startNs);
  return Array.from(lanes.values()).sort((a, b) => a.nativeThreadId - b.nativeThreadId);
}

function nativeThreadFor(
  trace: Trace,
  rubyThreadId: number,
  segment: Segment,
  eventsBySequence: Map<number, number | null>,
): number | null {
  if (segment.sequence > 0) return eventsBySequence.get(segment.sequence) ?? null;
  // An inferred initial RUNNING has no opening event; fall back to the thread's
  // first known native thread. The segment is already labelled inferred.
  return trace.threads.get(rubyThreadId)?.first_native_thread_id ?? null;
}
