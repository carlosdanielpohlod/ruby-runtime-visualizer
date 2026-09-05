// Lane layout for both views and the per-viewport render data for each lane,
// plus hit testing over that data. Pure functions; the components only draw.

import type { TraceModel } from "../model";
import type { GcSpan, ThreadMarkers, Tick } from "../model/markers";
import type { GvlSegment, Segment } from "../model/timeline";
import { threadLabel } from "../protocol/types";
import { threadColor } from "./colors";
import { blockAt, bucketTicks, firstIntersecting, visibleBlocks, type RenderBlock, type TickBucket } from "./culling";
import { GVL_LANE_HEIGHT, LANE_HEIGHT, SEGMENT_INSET, TICK_BAND } from "./geometry";
import type { Viewport } from "./viewport";

export type LaneView = "ruby" | "native";

interface RowBase {
  key: string;
  label: string;
  sublabel: string;
  y: number;
  height: number;
}

export interface ThreadRow extends RowBase {
  kind: "thread";
  rubyThreadId: number;
  color: string;
  segments: Segment[];
  markers: ThreadMarkers | undefined;
}

export interface NativeRow extends RowBase {
  kind: "native";
  nativeThreadId: number;
  segments: Segment[];
}

export interface GvlRow extends RowBase {
  kind: "gvl";
  segments: GvlSegment[];
}

export type LaneRow = ThreadRow | NativeRow | GvlRow;

export function buildRows(model: TraceModel, view: LaneView, showRecorder: boolean, colors: Map<number, string>): LaneRow[] {
  const rows: LaneRow[] = [];
  let y = 0;
  if (view === "ruby") {
    for (const lane of model.threadLanes) {
      if (lane.isRecorder && !showRecorder) continue;
      rows.push({
        kind: "thread",
        key: `thread:${lane.rubyThreadId}`,
        label: lane.label,
        sublabel: lane.nativeThreadIds.length ? `tid ${lane.nativeThreadIds.join(", ")}` : "tid unknown",
        y,
        height: LANE_HEIGHT,
        rubyThreadId: lane.rubyThreadId,
        color: threadColor(colors, lane.rubyThreadId),
        segments: model.timeline.threadSegments.get(lane.rubyThreadId) ?? [],
        markers: model.markers.get(lane.rubyThreadId),
      });
      y += LANE_HEIGHT;
    }
  } else {
    const hidden = new Set(model.threadLanes.filter((lane) => lane.isRecorder && !showRecorder).map((lane) => lane.rubyThreadId));
    for (const lane of model.nativeLanes) {
      const rubyThreadIds = lane.rubyThreadIds.filter((id) => !hidden.has(id));
      if (rubyThreadIds.length === 0) continue;
      rows.push({
        kind: "native",
        key: `native:${lane.nativeThreadId}`,
        label: `tid ${lane.nativeThreadId}`,
        sublabel: rubyThreadIds.map((id) => threadLabel(model.trace, id)).join(", "),
        y,
        height: LANE_HEIGHT,
        nativeThreadId: lane.nativeThreadId,
        segments: hidden.size === 0 ? lane.segments : lane.segments.filter((s) => !hidden.has(s.rubyThreadId)),
      });
      y += LANE_HEIGHT;
    }
  }
  rows.push({
    kind: "gvl",
    key: "gvl",
    label: "GVL",
    sublabel: "owner",
    y,
    height: GVL_LANE_HEIGHT,
    segments: model.timeline.gvlSegments,
  });
  return rows;
}

export function rowsHeight(rows: readonly LaneRow[]): number {
  const last = rows[rows.length - 1];
  return last ? last.y + last.height : 0;
}

export type RowRender =
  | { kind: "state"; row: ThreadRow | NativeRow; blocks: RenderBlock<Segment>[]; ticks: TickBucket<Tick>[]; gcSpans: GcSpan[] }
  | { kind: "gvl"; row: GvlRow; blocks: RenderBlock<GvlSegment>[]; ticks: TickBucket<Tick>[]; gcSpans: GcSpan[] };

export function renderRows(rows: readonly LaneRow[], viewport: Viewport): RowRender[] {
  return rows.map((row): RowRender => {
    if (row.kind === "gvl") return { kind: "gvl", row, blocks: visibleBlocks(row.segments, viewport), ticks: [], gcSpans: [] };
    const markers = row.kind === "thread" ? row.markers : undefined;
    return {
      kind: "state",
      row,
      blocks: visibleBlocks(row.segments, viewport),
      ticks: markers ? bucketTicks(markers.ticks, (t) => t.event.timestamp_ns, viewport) : [],
      gcSpans: markers ? visibleGcSpans(markers.gcSpans, viewport) : [],
    };
  });
}

function visibleGcSpans(spans: readonly GcSpan[], viewport: Viewport): GcSpan[] {
  const visible: GcSpan[] = [];
  for (let i = firstIntersecting(spans, viewport.startNs); i < spans.length; i += 1) {
    const span = spans[i];
    if (!span || span.startNs >= viewport.endNs) break;
    visible.push(span);
  }
  return visible;
}

export type Hit =
  | { kind: "segment"; row: ThreadRow | NativeRow; segment: Segment; x: number; width: number }
  | { kind: "gvl"; row: GvlRow; segment: GvlSegment; x: number; width: number }
  | { kind: "dense"; row: LaneRow; startNs: number; endNs: number; count: number; x: number; width: number }
  | { kind: "ticks"; row: ThreadRow | NativeRow; bucket: TickBucket<Tick> }
  | { kind: "gc"; row: ThreadRow | NativeRow; span: GcSpan };

/** What lies under a point of the time area, `x` relative to the time origin, `y` to the lanes' top. */
export function hitTest(renders: readonly RowRender[], viewport: Viewport, x: number, y: number): Hit | null {
  const render = renders.find((r) => y >= r.row.y && y < r.row.y + r.row.height);
  if (!render) return null;
  const { row } = render;
  const localY = y - row.y;

  if (render.kind === "gvl") {
    const block = blockAt(render.blocks, x);
    if (!block) return null;
    if (block.kind === "item") return { kind: "gvl", row: render.row, segment: block.item, x: block.x, width: block.width };
    return { kind: "dense", row, startNs: block.startNs, endNs: block.endNs, count: block.items.length, x: block.x, width: block.width };
  }

  // Markers sit in thin bands above and below the state rectangles; a point
  // in a band that misses every marker falls through to the state below it.
  if (localY >= row.height - TICK_BAND) {
    const bucket = render.ticks.find((b) => Math.abs(b.x - x) <= 2);
    if (bucket) return { kind: "ticks", row: render.row, bucket };
  }
  if (localY < SEGMENT_INSET) {
    const ns = viewport.startNs + (x / viewport.width) * (viewport.endNs - viewport.startNs);
    const span = render.gcSpans.find((s) => s.startNs <= ns && ns < s.endNs);
    if (span) return { kind: "gc", row: render.row, span };
  }
  const block = blockAt(render.blocks, x);
  if (!block) return null;
  if (block.kind === "item") return { kind: "segment", row: render.row, segment: block.item, x: block.x, width: block.width };
  return { kind: "dense", row, startNs: block.startNs, endNs: block.endNs, count: block.items.length, x: block.x, width: block.width };
}
