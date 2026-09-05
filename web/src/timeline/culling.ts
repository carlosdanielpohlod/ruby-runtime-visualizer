// Turns a lane's intervals into the rectangles worth drawing for the current
// viewport: only what intersects the window, with runs of sub-pixel intervals
// merged into single "dense" blocks. SVG cost is per element, so a lane with
// 50k segments must still emit at most a few hundred nodes.

import { nsToX, type Viewport } from "./viewport";

/** Intervals narrower than this many pixels are candidates for merging. */
export const DENSE_THRESHOLD_PX = 1;

export interface Interval {
  startNs: number;
  endNs: number;
}

export interface ItemBlock<T> {
  kind: "item";
  item: T;
  x: number;
  width: number;
}

export interface DenseBlock<T> {
  kind: "dense";
  x: number;
  width: number;
  startNs: number;
  endNs: number;
  items: T[];
}

export type RenderBlock<T> = ItemBlock<T> | DenseBlock<T>;

/** Index of the first interval whose end is after `ns` (intervals ordered by start, non-overlapping). */
export function firstIntersecting(intervals: readonly Interval[], ns: number): number {
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const interval = intervals[mid];
    if (interval && interval.endNs <= ns) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function visibleBlocks<T extends Interval>(items: readonly T[], viewport: Viewport): RenderBlock<T>[] {
  const blocks: RenderBlock<T>[] = [];
  let run: { items: T[]; x: number; xEnd: number } | null = null;

  const flush = (): void => {
    if (!run) return;
    const first = run.items[0];
    const last = run.items[run.items.length - 1];
    if (first && last) {
      const width = Math.max(run.xEnd - run.x, DENSE_THRESHOLD_PX);
      if (run.items.length === 1) blocks.push({ kind: "item", item: first, x: run.x, width });
      else blocks.push({ kind: "dense", x: run.x, width, startNs: first.startNs, endNs: last.endNs, items: run.items });
    }
    run = null;
  };

  for (let i = firstIntersecting(items, viewport.startNs); i < items.length; i += 1) {
    const item = items[i];
    if (!item || item.startNs >= viewport.endNs) break;
    const x = nsToX(viewport, item.startNs);
    const xEnd = nsToX(viewport, item.endNs);
    const width = xEnd - x;
    if (width >= DENSE_THRESHOLD_PX) {
      flush();
      blocks.push({ kind: "item", item, x, width });
      continue;
    }
    // A narrow interval joins the current run if it starts within a pixel of
    // where the run ends; otherwise it starts a new one.
    if (run && x - run.xEnd < DENSE_THRESHOLD_PX) {
      run.items.push(item);
      run.xEnd = Math.max(run.xEnd, xEnd);
    } else {
      flush();
      run = { items: [item], x, xEnd };
    }
  }
  flush();
  return blocks;
}

/** The key with the largest total duration among `items`. */
export function dominantKey<T extends Interval, K>(items: readonly T[], keyOf: (item: T) => K): K {
  const totals = new Map<K, number>();
  let best: K = keyOf(items[0] as T);
  let bestTotal = -1;
  for (const item of items) {
    const key = keyOf(item);
    const total = (totals.get(key) ?? 0) + (item.endNs - item.startNs);
    totals.set(key, total);
    if (total > bestTotal) {
      best = key;
      bestTotal = total;
    }
  }
  return best;
}

export function blockAt<T>(blocks: readonly RenderBlock<T>[], x: number): RenderBlock<T> | null {
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const block = blocks[mid];
    if (!block) break;
    if (x < block.x) hi = mid - 1;
    else if (x >= block.x + block.width) lo = mid + 1;
    else return block;
  }
  return null;
}

export interface TickBucket<T> {
  x: number;
  items: T[];
}

/**
 * Groups point markers by integer pixel so that thousands of source_line
 * ticks in one column become one element with a count.
 */
export function bucketTicks<T>(items: readonly T[], timestampOf: (item: T) => number, viewport: Viewport): TickBucket<T>[] {
  const buckets: TickBucket<T>[] = [];
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const item = items[mid];
    if (item && timestampOf(item) < viewport.startNs) lo = mid + 1;
    else hi = mid;
  }
  let current: TickBucket<T> | null = null;
  for (let i = lo; i < items.length; i += 1) {
    const item = items[i];
    if (!item) break;
    const ns = timestampOf(item);
    if (ns > viewport.endNs) break;
    const x = Math.floor(nsToX(viewport, ns));
    if (current && current.x === x) current.items.push(item);
    else {
      current = { x, items: [item] };
      buckets.push(current);
    }
  }
  return buckets;
}
