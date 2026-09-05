import { describe, expect, it } from "vitest";
import { FIXTURES } from "../__fixtures__";
import { buildTraceModel } from "../model";
import { parseTrace } from "../protocol/parser";
import { buildThreadColors } from "./colors";
import { GVL_LANE_HEIGHT, LANE_HEIGHT, SEGMENT_INSET, TICK_BAND } from "./geometry";
import { buildRows, hitTest, renderRows, rowsHeight } from "./rows";
import { fitViewport, nsToX } from "./viewport";

const model = buildTraceModel(parseTrace(FIXTURES.mutex, "mutex.rvtrace"));
const colors = buildThreadColors(model.threadLanes.map((l) => l.rubyThreadId));
const bounds = { startNs: model.trace.startNs, endNs: model.trace.endNs };

describe("buildRows", () => {
  it("lays out one lane per Ruby thread plus the GVL lane", () => {
    const rows = buildRows(model, "ruby", false, colors);
    expect(rows.map((r) => r.label)).toEqual(["main", "Thread #2", "Thread #3", "GVL"]);
    expect(rows.map((r) => r.y)).toEqual([0, LANE_HEIGHT, LANE_HEIGHT * 2, LANE_HEIGHT * 3]);
    expect(rowsHeight(rows)).toBe(LANE_HEIGHT * 3 + GVL_LANE_HEIGHT);
  });

  it("keys native lanes by native thread id and lists the Ruby threads on them", () => {
    const rows = buildRows(model, "native", false, colors);
    expect(rows.slice(0, -1).map((r) => [r.label, r.sublabel])).toEqual([
      ["tid 305184", "main"],
      ["tid 305267", "Thread #2"],
      ["tid 305268", "Thread #3"],
    ]);
  });

  it("hides the recorder thread unless asked", () => {
    const text = FIXTURES.mutex.replace('"process_id"', '"recorder_thread_id":2,"process_id"');
    const withRecorder = buildTraceModel(parseTrace(text));
    expect(buildRows(withRecorder, "ruby", false, colors).map((r) => r.label)).toEqual(["main", "Thread #3", "GVL"]);
    expect(buildRows(withRecorder, "ruby", true, colors).map((r) => r.label)).toEqual(["main", "Thread #2", "Thread #3", "GVL"]);
    expect(buildRows(withRecorder, "native", false, colors).map((r) => r.label)).toEqual(["tid 305184", "tid 305268", "GVL"]);
  });
});

describe("hitTest", () => {
  const viewport = fitViewport(bounds, 1000);
  const rows = buildRows(model, "ruby", false, colors);
  const renders = renderRows(rows, viewport);
  const waiting = model.timeline.threadSegments.get(3)?.find((s) => s.state === "WAITING_MUTEX");
  if (!waiting) throw new Error("fixture should have a WAITING_MUTEX segment");
  const midX = nsToX(viewport, (waiting.startNs + waiting.endNs) / 2);

  it("finds the segment under the pointer in the segment band", () => {
    const hit = hitTest(renders, viewport, midX, LANE_HEIGHT * 2 + SEGMENT_INSET + 5);
    expect(hit?.kind).toBe("segment");
    if (hit?.kind === "segment") expect(hit.segment).toBe(waiting);
  });

  it("finds probe ticks in the marker band", () => {
    const lockWait = model.trace.events.find((e) => e.type === "mutex_lock_wait" && e.ruby_thread_id === 3);
    if (!lockWait) throw new Error("fixture should have a mutex_lock_wait on thread 3");
    const hit = hitTest(renders, viewport, nsToX(viewport, lockWait.timestamp_ns), LANE_HEIGHT * 3 - TICK_BAND + 2);
    expect(hit?.kind).toBe("ticks");
    if (hit?.kind === "ticks") expect(hit.bucket.items[0]?.event.type).toBe("mutex_lock_wait");
  });

  it("finds GVL segments on the GVL lane and nothing outside the lanes", () => {
    const hit = hitTest(renders, viewport, midX, LANE_HEIGHT * 3 + 10);
    expect(hit?.kind).toBe("gvl");
    expect(hitTest(renders, viewport, midX, 1000)).toBeNull();
  });
});
