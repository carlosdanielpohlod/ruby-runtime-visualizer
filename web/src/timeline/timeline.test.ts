import { describe, expect, it } from "vitest";
import type { Segment } from "../model/timeline";
import { blockAt, bucketTicks, dominantKey, visibleBlocks } from "./culling";
import { formatDuration, formatTime } from "./format";
import { niceStep, rulerTicks } from "./ticks";
import { fitViewport, nsToX, panByPixels, xToNs, zoomAround, zoomToRange } from "./viewport";

const bounds = { startNs: 1_000_000, endNs: 2_000_000 };

describe("viewport", () => {
  it("fits the whole trace", () => {
    const vp = fitViewport(bounds, 500);
    expect(vp).toEqual({ startNs: 1_000_000, endNs: 2_000_000, width: 500 });
    expect(nsToX(vp, 1_500_000)).toBe(250);
    expect(xToNs(vp, 250)).toBe(1_500_000);
  });

  it("zooms around the anchor pixel, keeping its time fixed", () => {
    const vp = fitViewport(bounds, 1000);
    const zoomed = zoomAround(vp, bounds, 250, 2);
    expect(zoomed.endNs - zoomed.startNs).toBe(500_000);
    expect(xToNs(zoomed, 250)).toBeCloseTo(xToNs(vp, 250));
  });

  it("never leaves the trace bounds and never exceeds the full span", () => {
    const vp = fitViewport(bounds, 1000);
    const out = zoomAround(vp, bounds, 0, 0.5);
    expect(out).toMatchObject(bounds);
    const zoomed = zoomAround(vp, bounds, 1000, 4);
    const panned = panByPixels(zoomed, bounds, 5000);
    expect(panned.endNs).toBe(bounds.endNs);
    expect(panByPixels(zoomed, bounds, -5000).startNs).toBe(bounds.startNs);
  });

  it("zooms to a selected range in either direction", () => {
    const vp = fitViewport(bounds, 1000);
    expect(zoomToRange(vp, bounds, 1_600_000, 1_200_000)).toMatchObject({ startNs: 1_200_000, endNs: 1_600_000 });
  });
});

describe("ruler ticks", () => {
  it("rounds steps to 1, 2, 5 times a power of ten", () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(150)).toBe(200);
    expect(niceStep(1_200_000)).toBe(2_000_000);
  });

  it("labels major ticks in the unit that fits the step", () => {
    const vp = fitViewport({ startNs: 0, endNs: 1_000_000_000 }, 1000);
    const majors = rulerTicks(vp, 0).filter((t) => t.major);
    expect(majors.map((t) => t.label)).toEqual(["0.0 s", "0.1 s", "0.2 s", "0.3 s", "0.4 s", "0.5 s", "0.6 s", "0.7 s", "0.8 s", "0.9 s", "1.0 s"]);
    const micro = rulerTicks(fitViewport({ startNs: 500, endNs: 5_500 }, 1000), 500).filter((t) => t.major);
    expect(micro.slice(0, 3).map((t) => t.label)).toEqual(["0.0 µs", "0.5 µs", "1.0 µs"]);
    const sub = rulerTicks(fitViewport({ startNs: 0, endNs: 25_000 }, 1000), 0).filter((t) => t.major);
    expect(sub.slice(0, 3).map((t) => t.label)).toEqual(["0 µs", "5 µs", "10 µs"]);
    const short = rulerTicks(fitViewport({ startNs: 0, endNs: 300_000_000 }, 1000), 0).filter((t) => t.major);
    expect(short.slice(0, 3).map((t) => t.label)).toEqual(["0 ms", "50 ms", "100 ms"]);
  });

  it("keeps the unit of the window's magnitude when zoomed deep into a trace", () => {
    const origin = 0;
    const vp = { startNs: 1_674_600_000, endNs: 1_676_600_000, width: 1000 };
    const labels = rulerTicks(vp, origin).filter((t) => t.major).map((t) => t.label);
    expect(labels.slice(0, 2)).toEqual(["1.6746 s", "1.6748 s"]);
  });

  it("is relative to the trace start and stays inside the viewport", () => {
    const vp = fitViewport({ startNs: 10_000, endNs: 20_000 }, 500);
    const ticks = rulerTicks(vp, 10_000);
    expect(ticks[0]?.ns).toBe(10_000);
    for (const tick of ticks) {
      expect(tick.x).toBeGreaterThanOrEqual(0);
      expect(tick.x).toBeLessThanOrEqual(500);
    }
  });
});

describe("formatting", () => {
  it("formats durations with three significant digits", () => {
    expect(formatDuration(1_210_000_000)).toBe("1.21 s");
    expect(formatDuration(21_234_567)).toBe("21.2 ms");
    expect(formatDuration(812_400)).toBe("812 µs");
    expect(formatDuration(34)).toBe("34 ns");
    expect(formatDuration(0)).toBe("0 ns");
  });

  it("formats cursor times with three decimals", () => {
    expect(formatTime(21_234_567)).toBe("21.235 ms");
    expect(formatTime(999)).toBe("999 ns");
  });
});

function segment(startNs: number, endNs: number, state: Segment["state"] = "RUNNING", sequence = 0): Segment {
  return { rubyThreadId: 1, state, startNs, endNs, precision: "observed", nativeEvent: null, sequence };
}

describe("visibleBlocks", () => {
  it("only emits segments intersecting the viewport", () => {
    const segments = [segment(0, 100), segment(100, 200), segment(200, 300), segment(300, 400)];
    const vp = { startNs: 150, endNs: 250, width: 1000 };
    const blocks = visibleBlocks(segments, vp);
    expect(blocks.map((b) => (b.kind === "item" ? b.item.startNs : "dense"))).toEqual([100, 200]);
  });

  it("merges runs of sub-pixel segments into one dense block", () => {
    const segments: Segment[] = [];
    for (let i = 0; i < 1000; i += 1) segments.push(segment(i, i + 1, i % 2 ? "RUNNING" : "WANTS_GVL", i + 1));
    segments.push(segment(1000, 2000, "SLEEPING", 1001));
    const blocks = visibleBlocks(segments, { startNs: 0, endNs: 2000, width: 200 });
    expect(blocks).toHaveLength(2);
    const dense = blocks[0];
    expect(dense).toMatchObject({ kind: "dense", x: 0, width: 100, startNs: 0, endNs: 1000 });
    if (dense?.kind !== "dense") throw new Error("expected a dense block");
    expect(dense.items).toHaveLength(1000);
    expect(dominantKey(dense.items, (s) => s.state)).toBe("WANTS_GVL");
    expect(blocks[1]).toMatchObject({ kind: "item", x: 100, width: 100 });
    expect(blockAt(blocks, 50)).toBe(dense);
    expect(blockAt(blocks, 150)).toBe(blocks[1]);
    expect(blockAt(blocks, 250)).toBeNull();
    // Zoomed in far enough, every segment is drawn individually.
    const zoomed = visibleBlocks(segments, { startNs: 0, endNs: 100, width: 1000 });
    expect(zoomed.every((b) => b.kind === "item")).toBe(true);
    expect(zoomed).toHaveLength(100);
  });

  it("gives an isolated narrow segment a minimum width instead of merging it", () => {
    const blocks = visibleBlocks([segment(0, 1), segment(1, 1000)], { startNs: 0, endNs: 1000, width: 100 });
    expect(blocks[0]).toMatchObject({ kind: "item", width: 1 });
  });
});

describe("bucketTicks", () => {
  it("groups ticks by pixel column inside the viewport", () => {
    const ticks = [5, 10, 11, 12, 500, 900, 1500];
    const buckets = bucketTicks(ticks, (t) => t, { startNs: 8, endNs: 1000, width: 100 });
    expect(buckets.map((b) => [b.x, b.items.length])).toEqual([
      [0, 3],
      [49, 1],
      [89, 1],
    ]);
  });
});
