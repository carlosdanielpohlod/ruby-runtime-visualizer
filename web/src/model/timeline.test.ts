import { describe, expect, it } from "vitest";
import { FIXTURES, type FixtureName } from "../__fixtures__";
import expectedCpuThreads from "../__fixtures__/expected/cpu_threads.json";
import expectedMutex from "../__fixtures__/expected/mutex.json";
import expectedSleep from "../__fixtures__/expected/sleep.json";
import expectedSleepRuby32 from "../__fixtures__/expected/sleep_ruby32.json";
import { parseTrace } from "../protocol/parser";
import { buildTimeline, gvlSegmentAt, segmentAt, type Segment, type Timeline } from "./timeline";

interface ExpectedSegment {
  state: string;
  start_ns: number;
  end_ns: number;
  precision: string;
  native_event: string | null;
  sequence: number;
}

interface Expected {
  threads: Record<string, ExpectedSegment[]>;
  gvl: { owner: number | null; start_ns: number; end_ns: number; precision: string }[];
  violations: unknown[];
}

const EXPECTED: Record<FixtureName, Expected> = {
  cpu_threads: expectedCpuThreads,
  sleep: expectedSleep,
  mutex: expectedMutex,
  sleep_ruby32: expectedSleepRuby32,
};

function load(name: FixtureName): { timeline: Timeline; trace: ReturnType<typeof parseTrace> } {
  const trace = parseTrace(FIXTURES[name], `${name}.rvtrace`);
  return { trace, timeline: buildTimeline(trace) };
}

function toExpected(segment: Segment): ExpectedSegment {
  return {
    state: segment.state,
    start_ns: segment.startNs,
    end_ns: segment.endNs,
    precision: segment.precision,
    native_event: segment.nativeEvent,
    sequence: segment.sequence,
  };
}

function allSegments(timeline: Timeline): Segment[] {
  return Array.from(timeline.threadSegments.values()).flat();
}

describe("buildTimeline against the Ruby reference model", () => {
  for (const name of Object.keys(EXPECTED) as FixtureName[]) {
    it(`produces the same thread segments as the reference for ${name}`, () => {
      const { timeline } = load(name);
      const expected = EXPECTED[name];
      expect(Array.from(timeline.threadSegments.keys()).sort()).toEqual(Object.keys(expected.threads).map(Number));
      for (const [id, segments] of Object.entries(expected.threads)) {
        expect(timeline.threadSegments.get(Number(id))?.map(toExpected)).toEqual(segments);
      }
    });

    it(`produces the same GVL segments as the reference for ${name}`, () => {
      const { timeline } = load(name);
      expect(
        timeline.gvlSegments.map((g) => ({ owner: g.owner, start_ns: g.startNs, end_ns: g.endNs, precision: g.precision })),
      ).toEqual(EXPECTED[name].gvl);
      expect(timeline.violations).toEqual(EXPECTED[name].violations);
    });
  }
});

describe("thread state model invariants", () => {
  for (const name of Object.keys(FIXTURES) as FixtureName[]) {
    it(`never has two threads RUNNING at the same instant (${name})`, () => {
      const { timeline } = load(name);
      const running = allSegments(timeline)
        .filter((s) => s.state === "RUNNING")
        .sort((a, b) => a.startNs - b.startNs);
      expect(running.length).toBeGreaterThan(0);
      for (let i = 1; i < running.length; i += 1) {
        const previous = running[i - 1];
        const current = running[i];
        if (!previous || !current) throw new Error("unreachable");
        expect(current.startNs).toBeGreaterThanOrEqual(previous.endNs);
      }
    });

    it(`covers the whole trace with GVL segments, no gaps or overlaps (${name})`, () => {
      const { trace, timeline } = load(name);
      const gvl = timeline.gvlSegments;
      expect(gvl[0]?.startNs).toBe(trace.startNs);
      expect(gvl[gvl.length - 1]?.endNs).toBe(trace.endNs);
      for (let i = 1; i < gvl.length; i += 1) expect(gvl[i]?.startNs).toBe(gvl[i - 1]?.endNs);
      for (const segment of gvl) {
        expect(segment.endNs).toBeGreaterThan(segment.startNs);
        expect(segment.precision).toBe(segment.owner === null ? "derived" : "observed");
      }
    });

    it(`keeps each thread's segments contiguous and ordered (${name})`, () => {
      const { timeline } = load(name);
      for (const segments of timeline.threadSegments.values()) {
        for (let i = 1; i < segments.length; i += 1) {
          expect(segments[i]?.startNs).toBe(segments[i - 1]?.endNs);
        }
      }
    });
  }

  it("opens RUNNING (observed) for the thread that started tracing and makes it the GVL owner", () => {
    const { trace, timeline } = load("cpu_threads");
    const first = timeline.threadSegments.get(1)?.[0];
    expect(first).toMatchObject({ state: "RUNNING", precision: "observed", startNs: trace.startNs, sequence: 1 });
    expect(timeline.gvlSegments[0]).toMatchObject({ owner: 1, startNs: trace.startNs, sequence: 1 });
  });

  it("yields exactly one WAITING_MUTEX segment, on thread 3, in the mutex fixture", () => {
    const { timeline } = load("mutex");
    const waiting = allSegments(timeline).filter((s) => s.state === "WAITING_MUTEX");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      rubyThreadId: 3,
      precision: "derived",
      nativeEvent: "RUBY_INTERNAL_THREAD_EVENT_SUSPENDED",
      sequence: 20,
      derivedFrom: { state: "WAITING_MUTEX", enterSequence: 19, exitSequence: 30 },
    });
  });

  it("yields SLEEPING segments enclosed by sleep probe events in the sleep fixture", () => {
    const { timeline } = load("sleep");
    const sleeping = allSegments(timeline).filter((s) => s.state === "SLEEPING");
    expect(sleeping.length).toBe(3);
    for (const segment of sleeping) {
      expect(segment.precision).toBe("derived");
      expect(segment.derivedFrom?.state).toBe("SLEEPING");
      expect(segment.derivedFrom?.startNs).toBeLessThanOrEqual(segment.startNs);
      expect(segment.derivedFrom?.endNs).toBeGreaterThanOrEqual(segment.endNs);
    }
  });

  it("treats Ruby 3.2's repeated SUSPENDED as a no-op", () => {
    const { timeline } = load("sleep_ruby32");
    const thread2 = timeline.threadSegments.get(2) ?? [];
    // Sequences 21/22, 30/31 and 36/37 are double SUSPENDED; each pair yields one segment.
    const suspendedLike = thread2.filter((s) => s.state === "SLEEPING" || s.state === "SUSPENDED");
    expect(suspendedLike.map((s) => s.sequence)).toEqual([21, 30, 36, 41]);
    expect(suspendedLike.map((s) => s.state)).toEqual(["SLEEPING", "SLEEPING", "SLEEPING", "SUSPENDED"]);
  });

  it("infers the state of a thread whose first event is not thread_started", () => {
    const trace = parseTrace(
      [
        '{"record":"header","trace_start_ns":100}',
        '{"record":"event","sequence":1,"timestamp_ns":100,"ruby_thread_id":1,"type":"tracing_started","source":"recorder"}',
        '{"record":"event","sequence":2,"timestamp_ns":150,"ruby_thread_id":5,"type":"wants_gvl","source":"cruby_internal_thread_event","native_event":"RUBY_INTERNAL_THREAD_EVENT_READY"}',
        '{"record":"event","sequence":3,"timestamp_ns":160,"ruby_thread_id":6,"type":"gvl_released","source":"cruby_internal_thread_event","native_event":"RUBY_INTERNAL_THREAD_EVENT_SUSPENDED"}',
        '{"record":"event","sequence":4,"timestamp_ns":170,"ruby_thread_id":7,"type":"thread_exited","source":"cruby_internal_thread_event","native_event":"RUBY_INTERNAL_THREAD_EVENT_EXITED"}',
        '{"record":"end","trace_end_ns":200}',
      ].join("\n"),
    );
    const timeline = buildTimeline(trace);
    expect(timeline.threadSegments.get(5)?.[0]).toMatchObject({ state: "SUSPENDED", precision: "inferred", startNs: 100, endNs: 150, sequence: 0 });
    expect(timeline.threadSegments.get(6)?.[0]).toMatchObject({ state: "RUNNING", precision: "inferred", startNs: 100, endNs: 160 });
    expect(timeline.threadSegments.get(7)?.[0]).toMatchObject({ state: "UNKNOWN", precision: "inferred", startNs: 100, endNs: 170 });
  });

  it("closes RUNNING with PREEMPTED when another thread acquires the GVL first", () => {
    const trace = parseTrace(
      [
        '{"record":"header","trace_start_ns":0}',
        '{"record":"event","sequence":1,"timestamp_ns":0,"ruby_thread_id":1,"type":"tracing_started","source":"recorder"}',
        '{"record":"event","sequence":2,"timestamp_ns":10,"ruby_thread_id":2,"type":"thread_started","source":"cruby_internal_thread_event","native_event":"RUBY_INTERNAL_THREAD_EVENT_STARTED"}',
        '{"record":"event","sequence":3,"timestamp_ns":20,"ruby_thread_id":2,"type":"gvl_acquired","source":"cruby_internal_thread_event","native_event":"RUBY_INTERNAL_THREAD_EVENT_RESUMED"}',
        '{"record":"event","sequence":4,"timestamp_ns":30,"ruby_thread_id":1,"type":"wants_gvl","source":"cruby_internal_thread_event","native_event":"RUBY_INTERNAL_THREAD_EVENT_READY"}',
        '{"record":"event","sequence":5,"timestamp_ns":40,"ruby_thread_id":2,"type":"gvl_released","source":"cruby_internal_thread_event","native_event":"RUBY_INTERNAL_THREAD_EVENT_SUSPENDED"}',
        '{"record":"event","sequence":6,"timestamp_ns":50,"ruby_thread_id":1,"type":"gvl_acquired","source":"cruby_internal_thread_event","native_event":"RUBY_INTERNAL_THREAD_EVENT_RESUMED"}',
        '{"record":"end","trace_end_ns":60}',
      ].join("\n"),
    );
    const timeline = buildTimeline(trace);
    expect(timeline.threadSegments.get(1)?.map((s) => [s.state, s.startNs, s.endNs, s.precision])).toEqual([
      ["RUNNING", 0, 20, "observed"],
      ["PREEMPTED", 20, 30, "derived"],
      ["WANTS_GVL", 30, 50, "observed"],
      ["RUNNING", 50, 60, "observed"],
    ]);
    expect(timeline.threadSegments.get(1)?.[1]).toMatchObject({ preemptedBy: 2, sequence: 3 });
    expect(timeline.gvlSegments.map((g) => [g.owner, g.startNs, g.endNs])).toEqual([
      [1, 0, 20],
      [2, 20, 40],
      [null, 40, 50],
      [1, 50, 60],
    ]);
    expect(timeline.violations).toEqual([]);
  });

  it("frees the lock when the owner reports READY without a SUSPENDED (Ruby 3.2 yield)", () => {
    const trace = parseTrace(
      [
        '{"record":"header","trace_start_ns":0}',
        '{"record":"event","sequence":1,"timestamp_ns":0,"ruby_thread_id":1,"type":"tracing_started","source":"recorder"}',
        '{"record":"event","sequence":2,"timestamp_ns":10,"ruby_thread_id":1,"type":"wants_gvl","source":"cruby_internal_thread_event","native_event":"RUBY_INTERNAL_THREAD_EVENT_READY"}',
        '{"record":"event","sequence":3,"timestamp_ns":12,"ruby_thread_id":1,"type":"gvl_acquired","source":"cruby_internal_thread_event","native_event":"RUBY_INTERNAL_THREAD_EVENT_RESUMED"}',
        '{"record":"end","trace_end_ns":22}',
      ].join("\n"),
    );
    const timeline = buildTimeline(trace);
    expect(timeline.threadSegments.get(1)?.map((s) => s.state)).toEqual(["RUNNING", "WANTS_GVL", "RUNNING"]);
    expect(timeline.gvlSegments.map((g) => [g.owner, g.startNs, g.endNs])).toEqual([
      [1, 0, 10],
      [null, 10, 12],
      [1, 12, 22],
    ]);
    expect(timeline.violations).toEqual([]);
  });

  it("reports a gvl_acquired by the current owner as a violation", () => {
    const trace = parseTrace(
      [
        '{"record":"header","trace_start_ns":0}',
        '{"record":"event","sequence":1,"timestamp_ns":0,"ruby_thread_id":1,"type":"tracing_started","source":"recorder"}',
        '{"record":"event","sequence":2,"timestamp_ns":10,"ruby_thread_id":1,"type":"gvl_acquired","source":"cruby_internal_thread_event","native_event":"RUBY_INTERNAL_THREAD_EVENT_RESUMED"}',
        '{"record":"end","trace_end_ns":20}',
      ].join("\n"),
    );
    const timeline = buildTimeline(trace);
    expect(timeline.violations).toEqual([{ sequence: 2, rubyThreadId: 1, message: "gvl_acquired while already the owner" }]);
  });

  it("looks up the state and GVL owner at a timestamp", () => {
    const { trace, timeline } = load("mutex");
    const thread3 = timeline.threadSegments.get(3) ?? [];
    const waiting = thread3.find((s) => s.state === "WAITING_MUTEX");
    if (!waiting) throw new Error("expected a WAITING_MUTEX segment");
    expect(segmentAt(thread3, waiting.startNs)?.state).toBe("WAITING_MUTEX");
    expect(segmentAt(thread3, waiting.endNs)?.state).not.toBe("WAITING_MUTEX");
    expect(segmentAt(thread3, trace.startNs)).toBeNull();
    expect(gvlSegmentAt(timeline.gvlSegments, trace.startNs)?.owner).toBe(1);
    expect(gvlSegmentAt(timeline.gvlSegments, trace.endNs)).toBeNull();
  });
});
