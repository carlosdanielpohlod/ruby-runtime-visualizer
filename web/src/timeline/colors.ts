// Colour assignments. The values live in styles.css as CSS variables; this
// module only decides which variable applies to what.

import type { ThreadState } from "../model/timeline";

export const STATE_FILL: Record<ThreadState, string> = {
  STARTED: "var(--state-started)",
  WANTS_GVL: "var(--state-wants-gvl)",
  RUNNING: "var(--state-running)",
  SUSPENDED: "var(--state-suspended)",
  PREEMPTED: "var(--state-preempted)",
  SLEEPING: "var(--state-sleeping)",
  WAITING_MUTEX: "var(--state-waiting-mutex)",
  EXITED: "var(--state-exited)",
  UNKNOWN: "var(--state-unknown)",
};

export const IDLE_FILL = "var(--gvl-idle)";

const THREAD_PALETTE = [
  "var(--thread-1)",
  "var(--thread-2)",
  "var(--thread-3)",
  "var(--thread-4)",
  "var(--thread-5)",
  "var(--thread-6)",
  "var(--thread-7)",
  "var(--thread-8)",
];

/** Stable colour per Ruby thread, by lane order. */
export function buildThreadColors(rubyThreadIds: readonly number[]): Map<number, string> {
  const colors = new Map<number, string>();
  rubyThreadIds.forEach((id, index) => colors.set(id, THREAD_PALETTE[index % THREAD_PALETTE.length] as string));
  return colors;
}

export function threadColor(colors: Map<number, string>, rubyThreadId: number | null): string {
  if (rubyThreadId === null) return IDLE_FILL;
  return colors.get(rubyThreadId) ?? "var(--thread-unknown)";
}
