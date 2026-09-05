// Types for the .rvtrace protocol (docs/event-protocol.md, schema version 1).
// Field names mirror the file so that a record in the inspector can be read
// side by side with the spec.

export type Precision = "observed" | "derived" | "inferred";

export type NativeThreadRole = "self" | "creator" | "unknown";

export const SCHEDULER_EVENT_TYPES = [
  "thread_started",
  "wants_gvl",
  "gvl_acquired",
  "gvl_released",
  "thread_exited",
] as const;
export type SchedulerEventType = (typeof SCHEDULER_EVENT_TYPES)[number];

export const GC_EVENT_TYPES = ["gc_enter", "gc_exit"] as const;
export type GcEventType = (typeof GC_EVENT_TYPES)[number];

export const PROBE_EVENT_TYPES = [
  "sleep_enter",
  "sleep_exit",
  "mutex_lock_wait",
  "mutex_acquired",
  "mutex_released",
] as const;
export type ProbeEventType = (typeof PROBE_EVENT_TYPES)[number];

export const RECORDER_EVENT_TYPES = [
  "tracing_started",
  "tracing_stopped",
  "events_dropped",
  "thread_pool_exhausted",
  "threads_unidentified",
] as const;
export type RecorderEventType = (typeof RECORDER_EVENT_TYPES)[number];

export type KnownEventType =
  | SchedulerEventType
  | GcEventType
  | ProbeEventType
  | RecorderEventType
  | "source_line";

export interface EventMetadata {
  native_thread_role?: NativeThreadRole;
  requested_ms?: number | null;
  mutex_id?: number;
  path?: string;
  path_id?: number;
  line?: number;
  count?: number;
  [key: string]: unknown;
}

export interface TraceEvent {
  sequence: number;
  timestamp_ns: number;
  ruby_thread_id: number;
  native_thread_id: number | null;
  ractor_id: number | null;
  /** Normalised type. Unknown types are kept so they can be listed, never interpreted. */
  type: KnownEventType | (string & {});
  native_event: string | null;
  source: string;
  precision: Precision;
  metadata: EventMetadata;
}

export interface TraceHeader {
  format?: string;
  schema_version?: number;
  process_id?: number;
  ruby_version?: string;
  ruby_engine?: string;
  ruby_platform?: string;
  clock?: string;
  clock_unit?: string;
  trace_start_ns?: number;
  scheduler?: { mn_threads?: boolean; timeslice_ms?: number };
  channels?: string[];
  buffer_capacity?: number;
  script?: string;
  recorder_version?: string;
  /** The recorder's own drain thread, when it is a Ruby thread of the traced process. */
  recorder_thread_id?: number;
}

export interface ThreadInfo {
  ruby_thread_id: number;
  name: string | null;
  main: boolean;
  first_native_thread_id: number | null;
  native_thread_ids: number[];
}

export interface SourceFile {
  id: number;
  path: string;
  content: string | null;
}

export interface TraceStats {
  events_recorded?: number;
  events_dropped?: number;
  buffer_high_water_mark?: number;
  buffer_capacity?: number;
  threads_seen?: number;
  threads_unidentified?: number;
  tracing_duration_ns?: number;
  drain_count?: number;
}

export interface Trace {
  name: string;
  header: TraceHeader;
  /** Sorted by sequence. */
  events: TraceEvent[];
  threads: Map<number, ThreadInfo>;
  sourceFiles: Map<number, SourceFile>;
  stats: TraceStats;
  trace_end_ns: number | null;
  /** Absolute monotonic ns of the tracing_started event. */
  startNs: number;
  /** trace_end_ns, or the last event when the file has no end record. */
  endNs: number;
  /** False when the file ended before its end record (crash or truncation). */
  complete: boolean;
  /** Lines that were not valid JSON records; they are skipped, not fatal. */
  malformedLines: number;
}

export function isSchedulerEvent(type: string): type is SchedulerEventType {
  return (SCHEDULER_EVENT_TYPES as readonly string[]).includes(type);
}

export function isProbeEvent(type: string): type is ProbeEventType {
  return (PROBE_EVENT_TYPES as readonly string[]).includes(type);
}

export function isGcEvent(type: string): type is GcEventType {
  return (GC_EVENT_TYPES as readonly string[]).includes(type);
}

export function isRecorderEvent(type: string): type is RecorderEventType {
  return (RECORDER_EVENT_TYPES as readonly string[]).includes(type);
}

export function threadLabel(trace: Trace, rubyThreadId: number): string {
  const info = trace.threads.get(rubyThreadId);
  if (info?.name) return info.name;
  if (info?.main) return "main";
  if (rubyThreadId === 0) return "unidentified";
  return `Thread #${rubyThreadId}`;
}
