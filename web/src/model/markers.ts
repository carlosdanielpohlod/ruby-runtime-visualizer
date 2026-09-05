// Point and interval markers drawn over the thread lanes: GC intervals,
// probe boundaries and source lines. None of these change a thread's state.

import { isGcEvent, isProbeEvent, type Trace, type TraceEvent } from "../protocol/types";

export interface GcSpan {
  rubyThreadId: number;
  startNs: number;
  endNs: number;
  enterSequence: number;
  /** null when the trace ended before gc_exit. */
  exitSequence: number | null;
}

export type TickKind = "probe" | "source_line" | "recorder";

export interface Tick {
  kind: TickKind;
  event: TraceEvent;
}

export interface ThreadMarkers {
  gcSpans: GcSpan[];
  /** Ordered by timestamp. */
  ticks: Tick[];
}

export function buildMarkers(trace: Trace): Map<number, ThreadMarkers> {
  const markers = new Map<number, ThreadMarkers>();
  const openGc = new Map<number, TraceEvent>();
  const markersFor = (id: number): ThreadMarkers => {
    let entry = markers.get(id);
    if (!entry) {
      entry = { gcSpans: [], ticks: [] };
      markers.set(id, entry);
    }
    return entry;
  };

  for (const event of trace.events) {
    const id = event.ruby_thread_id;
    if (id === 0) continue;
    if (isGcEvent(event.type)) {
      if (event.type === "gc_enter") {
        openGc.set(id, event);
      } else {
        const enter = openGc.get(id);
        if (!enter) continue;
        openGc.delete(id);
        markersFor(id).gcSpans.push({
          rubyThreadId: id,
          startNs: enter.timestamp_ns,
          endNs: event.timestamp_ns,
          enterSequence: enter.sequence,
          exitSequence: event.sequence,
        });
      }
    } else if (isProbeEvent(event.type)) {
      markersFor(id).ticks.push({ kind: "probe", event });
    } else if (event.type === "source_line") {
      markersFor(id).ticks.push({ kind: "source_line", event });
    } else if (event.type === "events_dropped" || event.type === "thread_pool_exhausted") {
      markersFor(id).ticks.push({ kind: "recorder", event });
    }
  }

  for (const [id, enter] of openGc) {
    markersFor(id).gcSpans.push({
      rubyThreadId: id,
      startNs: enter.timestamp_ns,
      endNs: trace.endNs,
      enterSequence: enter.sequence,
      exitSequence: null,
    });
  }

  for (const entry of markers.values()) {
    entry.ticks.sort((a, b) => a.event.timestamp_ns - b.event.timestamp_ns || a.event.sequence - b.event.sequence);
    entry.gcSpans.sort((a, b) => a.startNs - b.startNs);
  }
  return markers;
}
