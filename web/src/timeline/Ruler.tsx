import { memo, useMemo, useRef, type PointerEvent } from "react";
import { formatDuration, formatTime } from "./format";
import { LABEL_WIDTH, RULER_HEIGHT } from "./geometry";
import type { TimeRange } from "./selection";
import { rulerTicks } from "./ticks";
import { nsToX, xToNs, type Viewport } from "./viewport";

interface RulerProps {
  viewport: Viewport;
  originNs: number;
  endNs: number;
  cursorNs: number;
  range: TimeRange | null;
  onSeek: (ns: number) => void;
}

export const Ruler = memo(function Ruler({ viewport, originNs, endNs, cursorNs, range, onSeek }: RulerProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const scrubbing = useRef(false);
  const ticks = useMemo(() => rulerTicks(viewport, originNs), [viewport, originNs]);

  const seekAt = (event: PointerEvent<SVGSVGElement>): void => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.min(Math.max(event.clientX - rect.left - LABEL_WIDTH, 0), viewport.width);
    onSeek(xToNs(viewport, x));
  };

  const cursorX = nsToX(viewport, cursorNs);
  return (
    <svg
      ref={svgRef}
      className="ruler"
      width={LABEL_WIDTH + viewport.width}
      height={RULER_HEIGHT}
      role="slider"
      aria-label="Timeline cursor"
      aria-valuemin={0}
      aria-valuemax={Math.round(endNs - originNs)}
      aria-valuenow={Math.round(cursorNs - originNs)}
      aria-valuetext={formatTime(cursorNs - originNs)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        scrubbing.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        seekAt(event);
      }}
      onPointerMove={(event) => {
        if (scrubbing.current) seekAt(event);
      }}
      onPointerUp={(event) => {
        scrubbing.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      <rect className="ruler-bg" x={0} y={0} width={LABEL_WIDTH + viewport.width} height={RULER_HEIGHT} />
      <text x={10} y={18} className="ruler-origin">
        time since trace start
      </text>
      <g transform={`translate(${LABEL_WIDTH} 0)`}>
        {range && (
          <RangeOverlay x={nsToX(viewport, range.startNs)} xEnd={nsToX(viewport, range.endNs)} durationNs={range.endNs - range.startNs} />
        )}
        {ticks.map((tick) => (
          <g key={tick.ns}>
            <line className="ruler-tick" x1={tick.x} x2={tick.x} y1={tick.major ? RULER_HEIGHT - 10 : RULER_HEIGHT - 5} y2={RULER_HEIGHT} />
            {tick.major && (
              <text className="ruler-label" x={tick.x + 3} y={RULER_HEIGHT - 12}>
                {tick.label}
              </text>
            )}
          </g>
        ))}
        {cursorX >= 0 && cursorX <= viewport.width && (
          <path className="cursor-head" d={`M ${cursorX - 5} 0 L ${cursorX + 5} 0 L ${cursorX} 7 Z`} />
        )}
      </g>
    </svg>
  );
});

function RangeOverlay({ x, xEnd, durationNs }: { x: number; xEnd: number; durationNs: number }) {
  const left = Math.min(x, xEnd);
  const width = Math.abs(xEnd - x);
  return (
    <g>
      <rect className="range-overlay" x={left} y={0} width={width} height={RULER_HEIGHT} />
      <text className="range-label" x={left + width / 2} y={11} textAnchor="middle">
        {formatDuration(Math.abs(durationNs))}
      </text>
    </g>
  );
}
