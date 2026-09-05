import type { GvlSegment, Segment } from "../model/timeline";
import type { TraceEvent } from "../protocol/types";

export interface TimeRange {
  startNs: number;
  endNs: number;
}

export type Selection =
  | { kind: "segment"; segment: Segment }
  | { kind: "gvl"; segment: GvlSegment }
  | { kind: "event"; event: TraceEvent }
  | { kind: "dense"; laneLabel: string; startNs: number; endNs: number; count: number };

export function selectionKey(selection: Selection | null): string | null {
  if (!selection) return null;
  switch (selection.kind) {
    case "segment":
      return `segment:${selection.segment.rubyThreadId}:${selection.segment.startNs}:${selection.segment.state}`;
    case "gvl":
      return `gvl:${selection.segment.startNs}`;
    case "event":
      return `event:${selection.event.sequence}`;
    case "dense":
      return `dense:${selection.laneLabel}:${selection.startNs}`;
  }
}
