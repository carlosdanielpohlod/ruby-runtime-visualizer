// Writes a synthetic .rvtrace for rendering benchmarks: N threads taking
// turns on one lock, with random slice lengths, following the event
// protocol. Nothing in it comes from a real run; it exists to put a known
// number of segments in front of the renderer.
//
//   node scripts/synthetic-trace.mjs --events 100000 --threads 8 > /tmp/synthetic.rvtrace

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "100000" },
    threads: { type: "string", default: "8" },
    seed: { type: "string", default: "1" },
  },
});
const target = Number(values.events);
const threads = Number(values.threads);
let seed = Number(values.seed);
const random = () => {
  // deterministic LCG so a given seed always yields the same file
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const SCHED = "cruby_internal_thread_event";
const NATIVE = {
  thread_started: "RUBY_INTERNAL_THREAD_EVENT_STARTED",
  wants_gvl: "RUBY_INTERNAL_THREAD_EVENT_READY",
  gvl_acquired: "RUBY_INTERNAL_THREAD_EVENT_RESUMED",
  gvl_released: "RUBY_INTERNAL_THREAD_EVENT_SUSPENDED",
  thread_exited: "RUBY_INTERNAL_THREAD_EVENT_EXITED",
};

const lines = [];
let sequence = 0;
let now = 1_000_000_000_000;
const emit = (thread, type, source = SCHED) => {
  sequence += 1;
  lines.push(
    JSON.stringify({
      record: "event",
      sequence,
      timestamp_ns: now,
      ruby_thread_id: thread,
      native_thread_id: 10_000 + thread,
      ractor_id: 1,
      type,
      native_event: NATIVE[type] ?? null,
      source,
      precision: "observed",
      metadata: { native_thread_role: "self" },
    }),
  );
};

const start = now;
emit(1, "tracing_started", "recorder");
for (let t = 2; t <= threads; t++) {
  now += 1_000;
  emit(t, "thread_started");
  now += 1_000;
  emit(t, "wants_gvl");
}
now += 1_000;
emit(1, "gvl_released");

let owner = null;
let next = 2;
while (sequence < target - threads - 2) {
  now += 500;
  emit(next, "gvl_acquired");
  owner = next;
  now += Math.floor(20_000 + random() * 150_000);
  emit(owner, "gvl_released");
  now += 200;
  emit(owner, "wants_gvl");
  next = (owner % threads) + 1;
  if (next === 1) next = 2;
}
for (let t = 2; t <= threads; t++) {
  now += 1_000;
  emit(t, "thread_exited");
}
now += 1_000;
emit(1, "wants_gvl");
now += 500;
emit(1, "gvl_acquired");
now += 1_000;
emit(1, "tracing_stopped", "recorder");

const header = {
  record: "header",
  format: "rvtrace",
  schema_version: 1,
  process_id: 1,
  ruby_version: "synthetic",
  ruby_engine: "synthetic",
  ruby_platform: "none",
  clock: "CLOCK_MONOTONIC",
  clock_unit: "ns",
  trace_start_ns: start,
  scheduler: { mn_threads: false },
  channels: [SCHED, "recorder"],
  buffer_capacity: 0,
  script: `synthetic (${threads} threads, ${sequence} events)`,
};
const out = [JSON.stringify(header), ...lines];
for (let t = 1; t <= threads; t++) {
  out.push(JSON.stringify({ record: "thread", ruby_thread_id: t, name: t === 1 ? "main" : null, main: t === 1, first_native_thread_id: 10_000 + t, native_thread_ids: [10_000 + t] }));
}
out.push(JSON.stringify({ record: "end", trace_end_ns: now }));
process.stdout.write(`${out.join("\n")}\n`);
