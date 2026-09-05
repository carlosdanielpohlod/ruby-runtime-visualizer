import { memo } from "react";
import type { GvlSegment, Segment } from "../model/timeline";
import { threadLabel, type Trace } from "../protocol/types";
import { IDLE_FILL, STATE_FILL, threadColor } from "./colors";
import { dominantKey, type RenderBlock } from "./culling";
import { GC_BAND, LABEL_WIDTH, SEGMENT_INSET, TICK_BAND, labelThatFits } from "./geometry";
import { DENSE_DOTS, denseFill, derivedFill, PREEMPTED_STRIPES } from "./Patterns";
import type { LaneRow as LaneRowModel, RowRender } from "./rows";
import { nsToX, type Viewport } from "./viewport";

interface LaneRowProps {
  render: RowRender;
  viewport: Viewport;
  trace: Trace;
  threadColors: Map<number, string>;
  selectedKey: string | null;
}

export const LaneRow = memo(function LaneRow({ render, viewport, trace, threadColors, selectedKey }: LaneRowProps) {
  const { row } = render;
  return (
    <g transform={`translate(0 ${row.y})`}>
      <rect className="lane-bg" x={LABEL_WIDTH} y={0} width={viewport.width} height={row.height} />
      <line className="lane-divider" x1={0} x2={LABEL_WIDTH + viewport.width} y1={row.height - 0.5} y2={row.height - 0.5} />
      <g transform={`translate(${LABEL_WIDTH} 0)`}>
        {render.kind === "gvl"
          ? renderGvlBlocks(render.blocks, row, trace, threadColors, selectedKey)
          : renderStateBlocks(render.blocks, render.row, trace, threadColors, selectedKey)}
        {render.gcSpans.map((span) => {
          const x = Math.max(0, nsToX(viewport, span.startNs));
          const xEnd = Math.min(viewport.width, nsToX(viewport, span.endNs));
          return <rect key={span.enterSequence} className="gc-span" x={x} y={2} width={Math.max(xEnd - x, 1)} height={GC_BAND} />;
        })}
        {render.ticks.map((bucket) => (
          <line
            key={bucket.x}
            className={`tick tick-${bucket.items[0]?.kind ?? "probe"}`}
            x1={bucket.x + 0.5}
            x2={bucket.x + 0.5}
            y1={row.height - TICK_BAND}
            y2={row.height - 1}
            strokeWidth={bucket.items.length > 1 ? 2 : 1}
          />
        ))}
      </g>
      <LaneLabel row={row} />
    </g>
  );
});

function LaneLabel({ row }: { row: LaneRowModel }) {
  return (
    <g className="lane-label">
      <rect x={0} y={0} width={LABEL_WIDTH} height={row.height} className="lane-label-bg" />
      {row.kind === "thread" && <rect x={0} y={0} width={3} height={row.height} fill={row.color} />}
      <text x={10} y={row.kind === "gvl" ? 16 : 14} className="lane-title">
        {row.label}
      </text>
      {row.kind !== "gvl" && (
        <text x={10} y={27} className="lane-subtitle">
          {row.sublabel}
        </text>
      )}
    </g>
  );
}

function renderStateBlocks(
  blocks: readonly RenderBlock<Segment>[],
  row: Extract<LaneRowModel, { kind: "thread" | "native" }>,
  trace: Trace,
  threadColors: Map<number, string>,
  selectedKey: string | null,
) {
  const y = SEGMENT_INSET;
  const height = row.height - SEGMENT_INSET - TICK_BAND;
  return blocks.map((block) => {
    if (block.kind === "dense") {
      const state = dominantKey(block.items, (s) => s.state);
      return (
        <g key={`d${block.startNs}`}>
          <rect x={block.x} y={y} width={block.width} height={height} fill={denseFill(state)} />
          {labelIfFits(block.x, block.width, y + height / 2, `×${block.items.length}`)}
        </g>
      );
    }
    const { item: segment } = block;
    const key = `segment:${segment.rubyThreadId}:${segment.startNs}:${segment.state}`;
    const fill =
      segment.state === "PREEMPTED" ? PREEMPTED_STRIPES : segment.precision === "derived" ? derivedFill(segment.state) : STATE_FILL[segment.state];
    const label = row.kind === "native" ? threadLabel(trace, segment.rubyThreadId) : segment.state;
    const stroke = row.kind === "native" ? threadColor(threadColors, segment.rubyThreadId) : undefined;
    return (
      <g key={key} className={selectedKey === key ? "block selected" : "block"}>
        <rect
          x={block.x}
          y={y}
          width={block.width}
          height={height}
          fill={fill}
          stroke={stroke}
          strokeWidth={stroke ? 1.5 : undefined}
          strokeDasharray={segment.precision === "inferred" ? "3 2" : undefined}
          opacity={segment.precision === "inferred" ? 0.75 : undefined}
        />
        {labelIfFits(block.x, block.width, y + height / 2, label)}
      </g>
    );
  });
}

function renderGvlBlocks(
  blocks: readonly RenderBlock<GvlSegment>[],
  row: LaneRowModel,
  trace: Trace,
  threadColors: Map<number, string>,
  selectedKey: string | null,
) {
  const y = 4;
  const height = row.height - 8;
  return blocks.map((block) => {
    if (block.kind === "dense") {
      const owner = dominantKey(block.items, (s) => s.owner);
      return (
        <g key={`d${block.startNs}`}>
          <rect x={block.x} y={y} width={block.width} height={height} fill={threadColor(threadColors, owner)} />
          <rect x={block.x} y={y} width={block.width} height={height} fill={DENSE_DOTS} />
          {labelIfFits(block.x, block.width, y + height / 2, `×${block.items.length}`)}
        </g>
      );
    }
    const { item: segment } = block;
    const key = `gvl:${segment.startNs}`;
    const idle = segment.owner === null;
    return (
      <g key={key} className={selectedKey === key ? "block selected" : "block"}>
        <rect
          x={block.x}
          y={y}
          width={block.width}
          height={height}
          fill={idle ? IDLE_FILL : threadColor(threadColors, segment.owner)}
          strokeDasharray={idle ? "2 2" : undefined}
          className={idle ? "gvl-idle" : undefined}
        />
        {labelIfFits(block.x, block.width, y + height / 2, idle ? "idle" : threadLabel(trace, segment.owner as number))}
      </g>
    );
  });
}

function labelIfFits(x: number, width: number, centerY: number, label: string) {
  const text = labelThatFits(label, width);
  if (!text) return null;
  return (
    <text x={x + 4} y={centerY} className="block-label" dominantBaseline="central">
      {text}
    </text>
  );
}
