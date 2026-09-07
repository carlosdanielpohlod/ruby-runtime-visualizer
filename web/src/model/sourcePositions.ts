// Where each thread was in the source at a given time, from source_line events.

import type { SourceFile, Trace, TraceEvent } from "../protocol/types";

export interface SourcePosition {
  rubyThreadId: number;
  path: string;
  line: number;
  event: TraceEvent;
}

export interface SourceIndex {
  /** source_line events per thread, ordered by timestamp. */
  byThread: Map<number, TraceEvent[]>;
  /** Files by path, including ones only known from source_line events. */
  files: SourceFile[];
  hasLineEvents: boolean;
}

export function buildSourceIndex(trace: Trace): SourceIndex {
  const byThread = new Map<number, TraceEvent[]>();
  const filesByPath = new Map<string, SourceFile>();
  for (const file of trace.sourceFiles.values()) filesByPath.set(file.path, file);

  for (const event of trace.events) {
    if (event.type !== "source_line" || event.ruby_thread_id === 0) continue;
    let list = byThread.get(event.ruby_thread_id);
    if (!list) {
      list = [];
      byThread.set(event.ruby_thread_id, list);
    }
    list.push(event);
    const path = sourcePath(trace, event);
    if (path && !filesByPath.has(path)) filesByPath.set(path, { id: -filesByPath.size - 1, path, content: null });
  }
  for (const list of byThread.values()) list.sort((a, b) => a.timestamp_ns - b.timestamp_ns || a.sequence - b.sequence);

  return { byThread, files: Array.from(filesByPath.values()), hasLineEvents: byThread.size > 0 };
}

// metadata.path_id refers to a source_file record; a file the recorder could
// not embed is still named by its id.
export function sourcePath(trace: Trace, event: TraceEvent): string | null {
  const pathId = event.metadata.path_id;
  if (typeof pathId === "number") return trace.sourceFiles.get(pathId)?.path ?? `path #${pathId}`;
  return null;
}

/** The last line each thread reached at or before `ns`. */
export function positionsAt(trace: Trace, index: SourceIndex, ns: number): SourcePosition[] {
  const positions: SourcePosition[] = [];
  for (const [rubyThreadId, events] of index.byThread) {
    const event = lastAtOrBefore(events, ns);
    if (!event) continue;
    const path = sourcePath(trace, event);
    const line = event.metadata.line;
    if (path === null || typeof line !== "number") continue;
    positions.push({ rubyThreadId, path, line, event });
  }
  return positions;
}

function lastAtOrBefore(events: readonly TraceEvent[], ns: number): TraceEvent | null {
  let lo = 0;
  let hi = events.length - 1;
  let found: TraceEvent | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const event = events[mid];
    if (event && event.timestamp_ns <= ns) {
      found = event;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
