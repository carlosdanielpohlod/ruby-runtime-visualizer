// NDJSON reader for .rvtrace files. Records are consumed line by line so a
// file can be fed in chunks; a missing tail (no stats/end record) is
// tolerated and reported through `Trace.complete`.

import type { SourceFile, ThreadInfo, Trace, TraceEvent, TraceHeader, TraceStats } from "./types";

type Json = Record<string, unknown>;

export class TraceParser {
  private header: TraceHeader = {};
  private readonly events: TraceEvent[] = [];
  private readonly threads = new Map<number, ThreadInfo>();
  private readonly sourceFiles = new Map<number, SourceFile>();
  private stats: TraceStats = {};
  private traceEndNs: number | null = null;
  private malformedLines = 0;
  private remainder = "";
  private lines = 0;

  constructor(private readonly name: string) {}

  /** Number of lines consumed so far, for progress reporting. */
  get lineCount(): number {
    return this.lines;
  }

  push(chunk: string): void {
    const text = this.remainder + chunk;
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) break;
      this.addLine(text.slice(start, newline));
      start = newline + 1;
    }
    this.remainder = text.slice(start);
  }

  finish(): Trace {
    if (this.remainder.trim() !== "") this.addLine(this.remainder);
    this.remainder = "";

    const events = this.events.slice().sort((a, b) => a.sequence - b.sequence);
    for (const event of events) {
      if (event.ruby_thread_id === 0) continue;
      // A thread without a `thread` record (the file ended early) is placed
      // from its own events, and only from callbacks that ran on its native
      // thread: STARTED on 3.3+ runs on the creator.
      const own = event.metadata.native_thread_role === "self" ? event.native_thread_id : null;
      const known = this.threads.get(event.ruby_thread_id);
      if (known === undefined) {
        this.threads.set(event.ruby_thread_id, {
          ruby_thread_id: event.ruby_thread_id,
          name: null,
          main: false,
          first_native_thread_id: own,
          native_thread_ids: own === null ? [] : [own],
        });
      } else if (known.name === null && !known.main && known.first_native_thread_id === null && own !== null) {
        known.first_native_thread_id = own;
        known.native_thread_ids = [own];
      }
    }

    const first = events[0];
    const last = events[events.length - 1];
    const startNs = this.header.trace_start_ns ?? first?.timestamp_ns ?? 0;
    const endNs = this.traceEndNs ?? last?.timestamp_ns ?? startNs;

    return {
      name: this.name,
      header: this.header,
      events,
      threads: this.threads,
      sourceFiles: this.sourceFiles,
      stats: this.stats,
      trace_end_ns: this.traceEndNs,
      startNs,
      endNs,
      complete: this.traceEndNs !== null,
      malformedLines: this.malformedLines,
    };
  }

  private addLine(rawLine: string): void {
    const line = rawLine.trim();
    if (line === "") return;
    this.lines += 1;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.malformedLines += 1;
      return;
    }
    if (!isObject(record)) {
      this.malformedLines += 1;
      return;
    }
    this.addRecord(record);
  }

  private addRecord(record: Json): void {
    switch (record["record"]) {
      case "header":
        this.header = record as TraceHeader;
        break;
      case "event": {
        const event = eventFromRecord(record);
        if (event) this.events.push(event);
        else this.malformedLines += 1;
        break;
      }
      case "thread":
        this.addThread(record);
        break;
      case "source_file":
        this.addSourceFile(record);
        break;
      case "stats":
        this.stats = record as TraceStats;
        break;
      case "end":
        this.traceEndNs = numberOrNull(record["trace_end_ns"]);
        break;
      default:
        // Readers must ignore record kinds they do not know.
        break;
    }
  }

  private addThread(record: Json): void {
    const id = numberOrNull(record["ruby_thread_id"]);
    if (id === null) return;
    const first = numberOrNull(record["first_native_thread_id"]);
    const seen = record["native_thread_ids"];
    const nativeIds = Array.isArray(seen) ? seen.filter((n): n is number => typeof n === "number") : [];
    this.threads.set(id, {
      ruby_thread_id: id,
      name: typeof record["name"] === "string" ? record["name"] : null,
      main: record["main"] === true,
      first_native_thread_id: first ?? nativeIds[0] ?? null,
      native_thread_ids: nativeIds,
    });
  }

  private addSourceFile(record: Json): void {
    const id = numberOrNull(record["id"]);
    const path = record["path"];
    if (id === null || typeof path !== "string") return;
    this.sourceFiles.set(id, {
      id,
      path,
      content: typeof record["content"] === "string" ? record["content"] : null,
    });
  }
}

function eventFromRecord(record: Json): TraceEvent | null {
  const sequence = numberOrNull(record["sequence"]);
  const timestamp = numberOrNull(record["timestamp_ns"]);
  const rubyThreadId = numberOrNull(record["ruby_thread_id"]);
  const type = record["type"];
  if (sequence === null || timestamp === null || rubyThreadId === null || typeof type !== "string") return null;
  const precision = record["precision"];
  const metadata = record["metadata"];
  return {
    sequence,
    timestamp_ns: timestamp,
    ruby_thread_id: rubyThreadId,
    native_thread_id: numberOrNull(record["native_thread_id"]),
    ractor_id: numberOrNull(record["ractor_id"]),
    type,
    native_event: typeof record["native_event"] === "string" ? record["native_event"] : null,
    source: typeof record["source"] === "string" ? record["source"] : "unknown",
    precision: precision === "derived" || precision === "inferred" ? precision : "observed",
    metadata: isObject(metadata) ? metadata : {},
  };
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseTrace(text: string, name = "trace.rvtrace"): Trace {
  const parser = new TraceParser(name);
  parser.push(text);
  return parser.finish();
}

export interface LoadProgress {
  bytesRead: number;
  bytesTotal: number | null;
  lines: number;
}

/**
 * Streams a source of bytes through the parser, yielding to the event loop
 * between chunks so the UI can show progress on large files.
 */
export async function parseTraceStream(
  stream: ReadableStream<Uint8Array>,
  name: string,
  bytesTotal: number | null,
  onProgress?: (progress: LoadProgress) => void,
): Promise<Trace> {
  const parser = new TraceParser(name);
  const decoder = new TextDecoder("utf-8");
  const reader = stream.getReader();
  let bytesRead = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    parser.push(decoder.decode(value, { stream: true }));
    onProgress?.({ bytesRead, bytesTotal, lines: parser.lineCount });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  parser.push(decoder.decode());
  return parser.finish();
}
