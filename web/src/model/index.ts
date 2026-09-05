// Everything the UI needs from a trace, computed once per loaded file.

import { threadLabel, type Trace } from "../protocol/types";
import { buildMarkers, type ThreadMarkers } from "./markers";
import { buildNativeLanes, type NativeLane } from "./nativeView";
import { buildSourceIndex, type SourceIndex } from "./sourcePositions";
import { buildTimeline, type Timeline } from "./timeline";

export interface ThreadLane {
  rubyThreadId: number;
  label: string;
  nativeThreadIds: number[];
  isRecorder: boolean;
}

export interface TraceModel {
  trace: Trace;
  timeline: Timeline;
  markers: Map<number, ThreadMarkers>;
  nativeLanes: NativeLane[];
  source: SourceIndex;
  /** One lane per Ruby thread, main first, then by id. */
  threadLanes: ThreadLane[];
  /** Event timestamps in sequence order, for stepping. */
  eventTimestamps: number[];
}

export function buildTraceModel(trace: Trace): TraceModel {
  const timeline = buildTimeline(trace);
  const ids = new Set<number>([...trace.threads.keys(), ...timeline.threadSegments.keys()]);
  ids.delete(0);
  const threadLanes = Array.from(ids)
    .sort((a, b) => {
      const mainA = trace.threads.get(a)?.main ? 0 : 1;
      const mainB = trace.threads.get(b)?.main ? 0 : 1;
      return mainA - mainB || a - b;
    })
    .map((id) => ({
      rubyThreadId: id,
      label: threadLabel(trace, id),
      nativeThreadIds: nativeThreadIdsFor(trace, id),
      isRecorder: trace.header.recorder_thread_id === id,
    }));

  return {
    trace,
    timeline,
    markers: buildMarkers(trace),
    nativeLanes: buildNativeLanes(trace, timeline),
    source: buildSourceIndex(trace),
    threadLanes,
    eventTimestamps: trace.events.map((e) => e.timestamp_ns),
  };
}

// Native threads this Ruby thread itself ran on: the recorder's snapshot plus
// callbacks with native_thread_role "self". A creator's or waker's tid is not
// this thread's tid.
function nativeThreadIdsFor(trace: Trace, rubyThreadId: number): number[] {
  const known = new Set<number>(trace.threads.get(rubyThreadId)?.native_thread_ids ?? []);
  for (const event of trace.events) {
    if (event.ruby_thread_id !== rubyThreadId || event.native_thread_id === null) continue;
    if (event.metadata.native_thread_role === "self") known.add(event.native_thread_id);
  }
  return Array.from(known).sort((a, b) => a - b);
}
