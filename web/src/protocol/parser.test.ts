import { describe, expect, it } from "vitest";
import { FIXTURES } from "../__fixtures__";
import { parseTrace, parseTraceStream, TraceParser } from "./parser";
import { threadLabel } from "./types";

describe("parseTrace", () => {
  it("reads header, events, threads, stats and end", () => {
    const trace = parseTrace(FIXTURES.mutex, "mutex.rvtrace");
    expect(trace.name).toBe("mutex.rvtrace");
    expect(trace.header.ruby_version).toBe("3.4.8");
    expect(trace.header.process_id).toBe(305184);
    expect(trace.header.channels).toContain("probe:mutex");
    expect(trace.events).toHaveLength(43);
    expect(trace.events.map((e) => e.sequence)).toEqual(Array.from({ length: 43 }, (_, i) => i + 1));
    expect(trace.threads.size).toBe(3);
    expect(trace.threads.get(1)).toMatchObject({ name: "main", main: true, first_native_thread_id: 305184 });
    expect(trace.threads.get(2)?.native_thread_ids).toEqual([305267]);
    expect(trace.stats.events_recorded).toBe(43);
    expect(trace.startNs).toBe(15280365157559);
    expect(trace.endNs).toBe(15280766618263);
    expect(trace.complete).toBe(true);
    expect(trace.malformedLines).toBe(0);
  });

  it("keeps event fields verbatim, defaulting optional ones", () => {
    const trace = parseTrace(FIXTURES.mutex);
    const first = trace.events[0];
    expect(first).toMatchObject({
      sequence: 1,
      type: "tracing_started",
      native_event: null,
      source: "recorder",
      precision: "observed",
      ractor_id: 1,
      metadata: { native_thread_role: "self" },
    });
    const mutexWait = trace.events.find((e) => e.type === "mutex_lock_wait");
    expect(mutexWait?.metadata.mutex_id).toBe(136);
  });

  it("labels threads by name, main, or number", () => {
    const trace = parseTrace(FIXTURES.sleep);
    expect(threadLabel(trace, 1)).toBe("main");
    expect(threadLabel(trace, 2)).toBe("Thread #2");
    expect(threadLabel(trace, 99)).toBe("Thread #99");
  });

  it("sorts events by sequence regardless of file order", () => {
    const lines = FIXTURES.sleep.split("\n");
    const header = lines[0] ?? "";
    const events = lines.filter((l) => l.includes('"record":"event"')).reverse();
    const trace = parseTrace([header, ...events].join("\n"));
    const sequences = trace.events.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it("tolerates a truncated file and reports it as incomplete", () => {
    const lines = FIXTURES.cpu_threads.split("\n").filter(Boolean);
    const cut = lines.slice(0, 20).join("\n") + "\n" + (lines[20] ?? "").slice(0, 40);
    const trace = parseTrace(cut);
    expect(trace.complete).toBe(false);
    expect(trace.trace_end_ns).toBeNull();
    expect(trace.events).toHaveLength(19);
    expect(trace.malformedLines).toBe(1);
    expect(trace.endNs).toBe(trace.events[trace.events.length - 1]?.timestamp_ns);
    // Threads without a thread record are still known from their events.
    // placed from its own RESUMED, not from the STARTED that ran on main's native thread
    expect(trace.threads.get(2)).toMatchObject({ name: null, main: false, first_native_thread_id: 304135 });
  });

  it("ignores unknown record kinds and blank lines", () => {
    const text = `${FIXTURES.sleep.split("\n")[0]}\n\n{"record":"future_thing","x":1}\n`;
    const trace = parseTrace(text);
    expect(trace.events).toHaveLength(0);
    expect(trace.malformedLines).toBe(0);
  });

  it("reads thread and source_file records", () => {
    const text = [
      '{"record":"header","trace_start_ns":10}',
      '{"record":"thread","ruby_thread_id":1,"name":"main","main":true,"first_native_thread_id":9122,"native_thread_ids":[9122,9130]}',
      '{"record":"source_file","id":1,"path":"/app/x.rb","content":"puts 1\\n"}',
      '{"record":"end","trace_end_ns":20}',
    ].join("\n");
    const trace = parseTrace(text);
    expect(trace.threads.get(1)).toMatchObject({ first_native_thread_id: 9122, native_thread_ids: [9122, 9130] });
    expect(trace.sourceFiles.get(1)).toEqual({ id: 1, path: "/app/x.rb", content: "puts 1\n" });
  });

  it("handles records split across chunks", () => {
    const parser = new TraceParser("chunked");
    const text = FIXTURES.sleep;
    for (let i = 0; i < text.length; i += 700) parser.push(text.slice(i, i + 700));
    const trace = parser.finish();
    expect(trace.events).toHaveLength(36);
    expect(trace.complete).toBe(true);
  });

  it("parses a byte stream", async () => {
    const bytes = new TextEncoder().encode(FIXTURES.mutex);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 1024) controller.enqueue(bytes.slice(i, i + 1024));
        controller.close();
      },
    });
    const progress: number[] = [];
    const trace = await parseTraceStream(stream, "mutex", bytes.length, (p) => progress.push(p.bytesRead));
    expect(trace.events).toHaveLength(43);
    expect(progress[progress.length - 1]).toBe(bytes.length);
  });
});
