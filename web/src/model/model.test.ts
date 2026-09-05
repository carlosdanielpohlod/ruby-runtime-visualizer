import { describe, expect, it } from "vitest";
import { FIXTURES } from "../__fixtures__";
import { parseTrace } from "../protocol/parser";
import { buildTraceModel } from "./index";
import { buildMarkers } from "./markers";
import { buildNativeLanes } from "./nativeView";
import { buildSourceIndex, positionsAt } from "./sourcePositions";
import { buildTimeline } from "./timeline";

describe("buildNativeLanes", () => {
  it("places every RUNNING segment on the native thread of its gvl_acquired event", () => {
    const trace = parseTrace(FIXTURES.cpu_threads);
    const timeline = buildTimeline(trace);
    const lanes = buildNativeLanes(trace, timeline);
    expect(lanes.map((l) => l.nativeThreadId)).toEqual([304051, 304135, 304136]);
    expect(lanes.map((l) => l.rubyThreadIds)).toEqual([[1], [2], [3]]);
    const running = Array.from(timeline.threadSegments.values())
      .flat()
      .filter((s) => s.state === "RUNNING").length;
    expect(lanes.reduce((n, l) => n + l.segments.length, 0)).toBe(running);
    for (const lane of lanes) for (const segment of lane.segments) expect(segment.state).toBe("RUNNING");
  });

  it("lets several Ruby threads share one native thread (M:N)", () => {
    const trace = parseTrace(
      [
        '{"record":"header","trace_start_ns":0}',
        '{"record":"event","sequence":1,"timestamp_ns":0,"ruby_thread_id":1,"native_thread_id":50,"type":"tracing_started","source":"recorder"}',
        '{"record":"event","sequence":2,"timestamp_ns":10,"ruby_thread_id":1,"native_thread_id":50,"type":"gvl_released","source":"cruby_internal_thread_event"}',
        '{"record":"event","sequence":3,"timestamp_ns":20,"ruby_thread_id":2,"native_thread_id":50,"type":"gvl_acquired","source":"cruby_internal_thread_event"}',
        '{"record":"event","sequence":4,"timestamp_ns":30,"ruby_thread_id":2,"native_thread_id":50,"type":"gvl_released","source":"cruby_internal_thread_event"}',
        '{"record":"event","sequence":5,"timestamp_ns":40,"ruby_thread_id":1,"native_thread_id":51,"type":"gvl_acquired","source":"cruby_internal_thread_event"}',
        '{"record":"end","trace_end_ns":60}',
      ].join("\n"),
    );
    const lanes = buildNativeLanes(trace, buildTimeline(trace));
    expect(lanes.map((l) => [l.nativeThreadId, l.rubyThreadIds, l.segments.map((s) => s.startNs)])).toEqual([
      [50, [1, 2], [0, 20]],
      [51, [1], [40]],
    ]);
  });
});

describe("buildMarkers", () => {
  it("collects probe ticks per thread and pairs gc_enter with gc_exit", () => {
    const trace = parseTrace(
      [
        '{"record":"header","trace_start_ns":0}',
        '{"record":"event","sequence":1,"timestamp_ns":0,"ruby_thread_id":1,"type":"tracing_started","source":"recorder"}',
        '{"record":"event","sequence":2,"timestamp_ns":5,"ruby_thread_id":1,"type":"gc_enter","source":"cruby_gc_tracepoint"}',
        '{"record":"event","sequence":3,"timestamp_ns":8,"ruby_thread_id":1,"type":"gc_exit","source":"cruby_gc_tracepoint"}',
        '{"record":"event","sequence":4,"timestamp_ns":9,"ruby_thread_id":2,"type":"sleep_enter","source":"probe"}',
        '{"record":"event","sequence":5,"timestamp_ns":12,"ruby_thread_id":2,"type":"gc_enter","source":"cruby_gc_tracepoint"}',
        '{"record":"end","trace_end_ns":20}',
      ].join("\n"),
    );
    const markers = buildMarkers(trace);
    expect(markers.get(1)?.gcSpans).toEqual([{ rubyThreadId: 1, startNs: 5, endNs: 8, enterSequence: 2, exitSequence: 3 }]);
    expect(markers.get(2)?.ticks.map((t) => t.kind)).toEqual(["probe"]);
    expect(markers.get(2)?.gcSpans).toEqual([{ rubyThreadId: 2, startNs: 12, endNs: 20, enterSequence: 5, exitSequence: null }]);
  });

  it("records the probe boundaries of the mutex fixture as ticks", () => {
    const trace = parseTrace(FIXTURES.mutex);
    const markers = buildMarkers(trace);
    expect(markers.get(3)?.ticks.map((t) => t.event.type)).toEqual([
      "mutex_lock_wait",
      "mutex_acquired",
      "sleep_enter",
      "sleep_exit",
      "mutex_released",
    ]);
  });
});

describe("source positions", () => {
  const trace = parseTrace(
    [
      '{"record":"header","trace_start_ns":0}',
      '{"record":"event","sequence":1,"timestamp_ns":0,"ruby_thread_id":1,"type":"tracing_started","source":"recorder"}',
      '{"record":"event","sequence":2,"timestamp_ns":10,"ruby_thread_id":1,"type":"source_line","source":"tracepoint","metadata":{"path_id":1,"line":3}}',
      '{"record":"event","sequence":3,"timestamp_ns":20,"ruby_thread_id":2,"type":"source_line","source":"tracepoint","metadata":{"path":"/other.rb","line":7}}',
      '{"record":"event","sequence":4,"timestamp_ns":30,"ruby_thread_id":1,"type":"source_line","source":"tracepoint","metadata":{"path_id":1,"line":4}}',
      '{"record":"source_file","id":1,"path":"/app.rb","content":"a\\nb\\nc\\nd\\n"}',
      '{"record":"end","trace_end_ns":40}',
    ].join("\n"),
  );
  const index = buildSourceIndex(trace);

  it("resolves path_id through source_file records and keeps plain paths", () => {
    expect(index.hasLineEvents).toBe(true);
    expect(index.files.map((f) => [f.path, f.content !== null])).toEqual([
      ["/app.rb", true],
      ["/other.rb", false],
    ]);
  });

  it("reports the last line each thread reached at the cursor", () => {
    expect(positionsAt(trace, index, 5)).toEqual([]);
    expect(positionsAt(trace, index, 25).map((p) => [p.rubyThreadId, p.path, p.line])).toEqual([
      [1, "/app.rb", 3],
      [2, "/other.rb", 7],
    ]);
    expect(positionsAt(trace, index, 30).find((p) => p.rubyThreadId === 1)?.line).toBe(4);
  });

  it("reports when line tracing was off", () => {
    expect(buildSourceIndex(parseTrace(FIXTURES.sleep)).hasLineEvents).toBe(false);
  });
});

describe("buildTraceModel", () => {
  it("orders lanes main first and flags the recorder thread", () => {
    const text = FIXTURES.sleep.replace('"process_id"', '"recorder_thread_id":3,"process_id"');
    const model = buildTraceModel(parseTrace(text));
    expect(model.threadLanes.map((l) => [l.rubyThreadId, l.label, l.isRecorder])).toEqual([
      [1, "main", false],
      [2, "Thread #2", false],
      [3, "Thread #3", true],
    ]);
    expect(model.threadLanes[1]?.nativeThreadIds).toEqual([model.trace.threads.get(2)?.first_native_thread_id]);
    expect(model.eventTimestamps).toHaveLength(36);
  });
});
