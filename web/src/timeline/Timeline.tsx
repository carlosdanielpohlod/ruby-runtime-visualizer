import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { TraceModel } from "../model";
import { EVENT_MEANINGS } from "../protocol/catalog";
import { threadLabel } from "../protocol/types";
import { threadColor } from "./colors";
import { formatDuration, formatTime } from "./format";
import { LABEL_WIDTH, RULER_HEIGHT } from "./geometry";
import { LaneRow } from "./LaneRow";
import { Patterns } from "./Patterns";
import { buildRows, hitTest, renderRows, rowsHeight, type Hit, type LaneView } from "./rows";
import { Ruler } from "./Ruler";
import { selectionKey, type Selection, type TimeRange } from "./selection";
import { Tooltip, type TooltipModel } from "./Tooltip";
import { nsToX, panByPixels, withWidth, xToNs, zoomAround, type TimeBounds, type Viewport } from "./viewport";

export interface TimelineProps {
  model: TraceModel;
  view: LaneView;
  showRecorder: boolean;
  threadColors: Map<number, string>;
  viewport: Viewport;
  onViewportChange: (viewport: Viewport) => void;
  cursorNs: number;
  onSeek: (ns: number) => void;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  range: TimeRange | null;
  onRangeChange: (range: TimeRange | null) => void;
}

interface Drag {
  mode: "pan" | "range";
  startClientX: number;
  startViewport: Viewport;
  anchorNs: number;
  moved: boolean;
}

const DRAG_THRESHOLD_PX = 3;
const WHEEL_ZOOM_SENSITIVITY = 0.0025;

export function Timeline(props: TimelineProps) {
  const { model, view, showRecorder, threadColors, viewport, onViewportChange, cursorNs, onSeek, selection, onSelect, range, onRangeChange } = props;
  const bodyRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const drag = useRef<Drag | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; model: TooltipModel } | null>(null);
  const [hoverBox, setHoverBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const bounds: TimeBounds = useMemo(() => ({ startNs: model.trace.startNs, endNs: model.trace.endNs }), [model]);

  const rows = useMemo(() => buildRows(model, view, showRecorder, threadColors), [model, view, showRecorder, threadColors]);
  const renders = useMemo(() => renderRows(rows, viewport), [rows, viewport]);
  const height = rowsHeight(rows);
  const selectedKey = selectionKey(selection);

  // The drawing width follows the container; the viewport keeps its time span.
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const width = Math.max(50, Math.floor((entries[0]?.contentRect.width ?? 0) - LABEL_WIDTH));
      onViewportChange(withWidth(viewportRef.current, width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onViewportChange]);

  // Wheel must be a non-passive listener to stop the browser from zooming the page.
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      const current = viewportRef.current;
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left - LABEL_WIDTH;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        onViewportChange(zoomAround(current, bounds, x, Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY)));
      } else if (event.shiftKey || (event.deltaX !== 0 && Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
        event.preventDefault();
        onViewportChange(panByPixels(current, bounds, event.shiftKey ? event.deltaY || event.deltaX : event.deltaX));
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [bounds, onViewportChange]);

  const pointerPosition = (event: ReactPointerEvent<SVGSVGElement>): { x: number; y: number } | null => {
    const rect = lanesRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: event.clientX - rect.left - LABEL_WIDTH, y: event.clientY - rect.top };
  };

  const describe = useCallback((hit: Hit): TooltipModel => describeHit(hit, model, threadColors), [model, threadColors]);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    const position = pointerPosition(event);
    if (!position || position.x < 0) return;
    drag.current = {
      mode: event.shiftKey ? "range" : "pan",
      startClientX: event.clientX,
      startViewport: viewport,
      anchorNs: xToNs(viewport, position.x),
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setTooltip(null);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const position = pointerPosition(event);
    if (!position) return;
    const current = drag.current;
    if (current) {
      const dx = event.clientX - current.startClientX;
      if (Math.abs(dx) > DRAG_THRESHOLD_PX) current.moved = true;
      if (!current.moved) return;
      if (current.mode === "pan") onViewportChange(panByPixels(current.startViewport, bounds, -dx));
      else onRangeChange(orderedRange(current.anchorNs, clampNs(xToNs(viewport, position.x), bounds)));
      return;
    }
    if (position.x < 0) {
      setTooltip(null);
      setHoverBox(null);
      return;
    }
    const hit = hitTest(renders, viewport, position.x, position.y);
    if (!hit) {
      setTooltip(null);
      setHoverBox(null);
      return;
    }
    setTooltip({ x: event.clientX, y: event.clientY, model: describe(hit) });
    setHoverBox(hitBox(hit));
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const current = drag.current;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (!current) return;
    const position = pointerPosition(event);
    if (current.moved || !position) return;
    // A click: move the cursor there and select whatever was under it.
    if (current.mode === "range") onRangeChange(null);
    onSeek(clampNs(xToNs(viewport, position.x), bounds));
    const hit = hitTest(renders, viewport, position.x, position.y);
    onSelect(hit ? selectionFor(hit, model) : null);
  };

  const cursorX = nsToX(viewport, cursorNs);
  const bodyRect = bodyRef.current?.getBoundingClientRect();
  return (
    <div className="timeline">
      <div className="timeline-body" ref={bodyRef} onPointerLeave={() => setTooltip(null)}>
        <div className="ruler-sticky">
          <Ruler viewport={viewport} originNs={model.trace.startNs} endNs={model.trace.endNs} cursorNs={cursorNs} range={range} onSeek={(ns) => onSeek(clampNs(ns, bounds))} />
        </div>
        <svg
          ref={lanesRef}
          className={`lanes${drag.current?.mode === "pan" ? " panning" : ""}`}
          width={LABEL_WIDTH + viewport.width}
          height={Math.max(height, 1)}
          role="img"
          aria-label="Thread lanes"
          data-visible-ns={viewport.endNs - viewport.startNs}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => {
            setTooltip(null);
            setHoverBox(null);
          }}
        >
          <Patterns />
          {renders.map((render) => (
            <LaneRow key={render.row.key} render={render} viewport={viewport} trace={model.trace} threadColors={threadColors} selectedKey={selectedKey} />
          ))}
          <g transform={`translate(${LABEL_WIDTH} 0)`}>
            {range && (
              <rect
                className="range-overlay"
                x={nsToX(viewport, range.startNs)}
                y={0}
                width={Math.max(0, nsToX(viewport, range.endNs) - nsToX(viewport, range.startNs))}
                height={height}
              />
            )}
            {hoverBox && <rect className="hover-box" x={hoverBox.x} y={hoverBox.y} width={hoverBox.width} height={hoverBox.height} />}
            {cursorX >= 0 && cursorX <= viewport.width && <line className="cursor-line" x1={cursorX} x2={cursorX} y1={0} y2={height} />}
          </g>
        </svg>
        {rows.length <= 1 && <p className="lanes-empty">No thread events in this trace.</p>}
      </div>
      {tooltip && bodyRect && (
        <Tooltip
          model={tooltip.model}
          x={tooltip.x - bodyRect.left}
          y={tooltip.y - bodyRect.top + RULER_HEIGHT}
          bounds={{ width: bodyRect.width, height: bodyRect.height + RULER_HEIGHT }}
        />
      )}
    </div>
  );
}

function clampNs(ns: number, bounds: TimeBounds): number {
  return Math.min(Math.max(ns, bounds.startNs), bounds.endNs);
}

function orderedRange(a: number, b: number): TimeRange {
  return { startNs: Math.min(a, b), endNs: Math.max(a, b) };
}

function hitBox(hit: Hit): { x: number; y: number; width: number; height: number } | null {
  if (hit.kind === "segment" || hit.kind === "gvl" || hit.kind === "dense") {
    return { x: hit.x, y: hit.row.y, width: hit.width, height: hit.row.height };
  }
  return null;
}

function selectionFor(hit: Hit, model: TraceModel): Selection | null {
  switch (hit.kind) {
    case "segment":
      return { kind: "segment", segment: hit.segment };
    case "gvl":
      return { kind: "gvl", segment: hit.segment };
    case "dense":
      return { kind: "dense", laneLabel: hit.row.label, startNs: hit.startNs, endNs: hit.endNs, count: hit.count };
    case "ticks": {
      const event = hit.bucket.items[0]?.event;
      return event ? { kind: "event", event } : null;
    }
    case "gc": {
      const event = model.trace.events.find((e) => e.sequence === hit.span.enterSequence);
      return event ? { kind: "event", event } : null;
    }
  }
}

function describeHit(hit: Hit, model: TraceModel, threadColors: Map<number, string>): TooltipModel {
  const { trace } = model;
  const origin = trace.startNs;
  switch (hit.kind) {
    case "segment": {
      const { segment } = hit;
      const nativeId = nativeThreadOf(model, segment.sequence, segment.rubyThreadId);
      return {
        title: `${segment.state} · ${threadLabel(trace, segment.rubyThreadId)}`,
        color: threadColor(threadColors, segment.rubyThreadId),
        lines: [
          ["Ruby thread", `${threadLabel(trace, segment.rubyThreadId)} (#${segment.rubyThreadId})`],
          ["Native thread", nativeId === null ? "unknown" : `tid ${nativeId}${segment.state === "RUNNING" ? "" : " (callback thread)"}`],
          ["Start", formatTime(segment.startNs - origin)],
          ["Duration", formatDuration(segment.endNs - segment.startNs)],
          ["Source channel", channelOf(segment.precision, segment.sequence, model)],
          ["Precision", segment.precision],
          ["Native event", segment.nativeEvent ?? (segment.sequence === 0 ? "none (before first event)" : "none")],
        ],
      };
    }
    case "gvl": {
      const { segment } = hit;
      const owner = segment.owner;
      return {
        title: owner === null ? "GVL idle" : `GVL owned by ${threadLabel(trace, owner)}`,
        color: threadColor(threadColors, owner),
        lines: [
          ["Start", formatTime(segment.startNs - origin)],
          ["Duration", formatDuration(segment.endNs - segment.startNs)],
          ["Precision", `${segment.precision} (endpoints observed, interval derived)`],
          ["Opened by", segment.sequence === 0 ? "trace start" : `seq ${segment.sequence}`],
        ],
      };
    }
    case "dense":
      return {
        title: `${hit.count} segments merged`,
        lines: [
          ["Lane", hit.row.label],
          ["Start", formatTime(hit.startNs - origin)],
          ["Duration", formatDuration(hit.endNs - hit.startNs)],
          ["Hint", "narrower than a pixel each; zoom in (ctrl + wheel) to resolve"],
        ],
      };
    case "ticks": {
      const first = hit.bucket.items[0]?.event;
      const count = hit.bucket.items.length;
      if (!first) return { title: "events", lines: [] };
      const meaning = EVENT_MEANINGS[first.type];
      const lines: [string, string][] = [
        ["Ruby thread", threadLabel(trace, first.ruby_thread_id)],
        ["Time", formatTime(first.timestamp_ns - origin)],
        ["Native event", first.native_event ?? meaning?.nativeEvent ?? "none"],
        ["Source channel", first.source],
      ];
      if (first.type === "source_line") lines.push(["Line", `${String(first.metadata.path ?? first.metadata.path_id ?? "?")}:${String(first.metadata.line ?? "?")}`]);
      if (count > 1) lines.push(["Merged", `${count} events in this pixel column`]);
      return { title: count > 1 ? `${first.type} (+${count - 1} more)` : `${first.type} · seq ${first.sequence}`, lines };
    }
    case "gc":
      return {
        title: "GC",
        lines: [
          ["Ruby thread", threadLabel(trace, hit.span.rubyThreadId)],
          ["Start", formatTime(hit.span.startNs - origin)],
          ["Duration", formatDuration(hit.span.endNs - hit.span.startNs)],
          ["Native events", `RUBY_INTERNAL_EVENT_GC_ENTER (seq ${hit.span.enterSequence}) → GC_EXIT${hit.span.exitSequence === null ? " (missing)" : ` (seq ${hit.span.exitSequence})`}`],
        ],
      };
  }
}

export function nativeThreadOf(model: TraceModel, sequence: number, rubyThreadId: number): number | null {
  if (sequence > 0) {
    const event = model.trace.events[sequence - 1];
    if (event && event.sequence === sequence) return event.native_thread_id;
    return model.trace.events.find((e) => e.sequence === sequence)?.native_thread_id ?? null;
  }
  return model.trace.threads.get(rubyThreadId)?.first_native_thread_id ?? null;
}

function channelOf(precision: string, sequence: number, model: TraceModel): string {
  if (precision === "inferred") return "model (inferred before first event)";
  if (precision === "derived") return "model (derived from observed events)";
  if (sequence === 0) return "model";
  const event = model.trace.events.find((e) => e.sequence === sequence);
  return event?.source ?? "unknown";
}
