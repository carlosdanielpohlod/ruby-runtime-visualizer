// The visible time window and its mapping to pixels. Timestamps are absolute
// nanoseconds as in the trace; doubles keep sub-nanosecond precision at the
// magnitudes CLOCK_MONOTONIC produces (~1e13), well inside 2^53.

export interface Viewport {
  startNs: number;
  endNs: number;
  /** Width of the drawing area in CSS pixels. */
  width: number;
}

export interface TimeBounds {
  startNs: number;
  endNs: number;
}

/** Never zoom past 1 ns per pixel; nothing in the trace resolves finer. */
const MIN_SPAN_NS = 1;

export function spanNs(viewport: Viewport): number {
  return viewport.endNs - viewport.startNs;
}

export function nsToX(viewport: Viewport, ns: number): number {
  return ((ns - viewport.startNs) / spanNs(viewport)) * viewport.width;
}

export function xToNs(viewport: Viewport, x: number): number {
  return viewport.startNs + (x / viewport.width) * spanNs(viewport);
}

export function fitViewport(bounds: TimeBounds, width: number): Viewport {
  const span = Math.max(bounds.endNs - bounds.startNs, MIN_SPAN_NS);
  return { startNs: bounds.startNs, endNs: bounds.startNs + span, width };
}

/**
 * Zoom by `factor` (> 1 zooms in) keeping the time under `anchorX` fixed:
 * the anchor's fraction of the span is preserved on both sides.
 */
export function zoomAround(viewport: Viewport, bounds: TimeBounds, anchorX: number, factor: number): Viewport {
  const anchorNs = xToNs(viewport, anchorX);
  const maxSpan = Math.max(bounds.endNs - bounds.startNs, MIN_SPAN_NS);
  const newSpan = clamp(spanNs(viewport) / factor, MIN_SPAN_NS, maxSpan);
  const fraction = (anchorNs - viewport.startNs) / spanNs(viewport);
  const startNs = anchorNs - fraction * newSpan;
  return clampToBounds({ startNs, endNs: startNs + newSpan, width: viewport.width }, bounds);
}

export function panByPixels(viewport: Viewport, bounds: TimeBounds, deltaX: number): Viewport {
  const deltaNs = (deltaX / viewport.width) * spanNs(viewport);
  return clampToBounds({ ...viewport, startNs: viewport.startNs + deltaNs, endNs: viewport.endNs + deltaNs }, bounds);
}

export function zoomToRange(viewport: Viewport, bounds: TimeBounds, startNs: number, endNs: number): Viewport {
  const lo = Math.min(startNs, endNs);
  const hi = Math.max(startNs, endNs);
  const span = Math.max(hi - lo, MIN_SPAN_NS);
  return clampToBounds({ startNs: lo, endNs: lo + span, width: viewport.width }, bounds);
}

/** Slide the window so that `ns` is visible, keeping the zoom level. */
export function ensureVisible(viewport: Viewport, bounds: TimeBounds, ns: number): Viewport {
  if (ns >= viewport.startNs && ns <= viewport.endNs) return viewport;
  const span = spanNs(viewport);
  const startNs = ns < viewport.startNs ? ns - span * 0.1 : ns - span * 0.9;
  return clampToBounds({ startNs, endNs: startNs + span, width: viewport.width }, bounds);
}

export function withWidth(viewport: Viewport, width: number): Viewport {
  return viewport.width === width ? viewport : { ...viewport, width };
}

function clampToBounds(viewport: Viewport, bounds: TimeBounds): Viewport {
  const span = spanNs(viewport);
  const maxSpan = Math.max(bounds.endNs - bounds.startNs, MIN_SPAN_NS);
  if (span >= maxSpan) return { ...viewport, startNs: bounds.startNs, endNs: bounds.startNs + maxSpan };
  let startNs = viewport.startNs;
  if (startNs < bounds.startNs) startNs = bounds.startNs;
  if (startNs + span > bounds.endNs) startNs = bounds.endNs - span;
  return { ...viewport, startNs, endNs: startNs + span };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
