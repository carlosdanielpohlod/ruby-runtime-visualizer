// SVG pattern definitions that make precision visible: derived segments are
// hatched, PREEMPTED is striped, merged runs are dotted. One pattern per
// state keeps every block a single rect, which matters at 10k+ elements.

import { THREAD_STATES, type ThreadState } from "../model/timeline";
import { STATE_FILL } from "./colors";

export const PREEMPTED_STRIPES = "url(#rv-preempted-stripes)";
export const DENSE_DOTS = "url(#rv-dense-dots)";

export function derivedFill(state: ThreadState): string {
  return `url(#rv-derived-${state})`;
}

export function denseFill(state: ThreadState): string {
  return `url(#rv-dense-${state})`;
}

export function Patterns() {
  return (
    <defs>
      <pattern id="rv-preempted-stripes" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
        <rect width="8" height="8" fill="var(--state-preempted)" />
        <rect width="4" height="8" fill="var(--state-preempted-stripe)" />
      </pattern>
      <pattern id="rv-dense-dots" width="4" height="4" patternUnits="userSpaceOnUse">
        <rect width="4" height="4" fill="transparent" />
        <circle cx="1" cy="1" r="0.8" fill="rgba(0,0,0,0.55)" />
      </pattern>
      {THREAD_STATES.map((state) => (
        <pattern key={`derived-${state}`} id={`rv-derived-${state}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill={STATE_FILL[state]} />
          <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(0,0,0,0.45)" strokeWidth="1.5" />
        </pattern>
      ))}
      {THREAD_STATES.map((state) => (
        <pattern key={`dense-${state}`} id={`rv-dense-${state}`} width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" fill={STATE_FILL[state]} />
          <circle cx="1" cy="1" r="0.8" fill="rgba(0,0,0,0.55)" />
        </pattern>
      ))}
    </defs>
  );
}
