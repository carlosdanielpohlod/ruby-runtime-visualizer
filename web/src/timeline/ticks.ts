// Ruler ticks at 1-2-5 steps of a power of ten, labelled in the unit that
// fits the step (ns, µs, ms, s), relative to the trace start.

import { formatTimeInUnit, unitFor } from "./format";
import { nsToX, spanNs, type Viewport } from "./viewport";

export interface RulerTick {
  x: number;
  ns: number;
  label: string;
  major: boolean;
}

const MIN_MAJOR_SPACING_PX = 90;

export function niceStep(rawStep: number): number {
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / power;
  const multiplier = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return multiplier * power;
}

export function rulerTicks(viewport: Viewport, originNs: number): RulerTick[] {
  if (viewport.width <= 0 || spanNs(viewport) <= 0) return [];
  const step = Math.max(1, niceStep((spanNs(viewport) / viewport.width) * MIN_MAJOR_SPACING_PX));
  const minor = step / (String(step / 10 ** Math.floor(Math.log10(step)))[0] === "2" ? 4 : 5);
  // The unit follows the largest labelled value, so a window deep inside a
  // long trace reads "1.6746 s" rather than "1674600 µs".
  const unit = unitFor(Math.max(Math.abs(viewport.endNs - originNs), step));
  const ticks: RulerTick[] = [];
  const firstRelative = Math.floor((viewport.startNs - originNs) / minor) * minor;
  for (let relative = firstRelative; relative <= viewport.endNs - originNs; relative += minor) {
    const ns = originNs + relative;
    if (ns < viewport.startNs) continue;
    // Round to the step grid to avoid 0.30000000000000004-style drift.
    const onMajor = Math.abs(relative / step - Math.round(relative / step)) < 1e-6;
    ticks.push({
      x: nsToX(viewport, ns),
      ns,
      label: onMajor ? formatTimeInUnit(relative, unit, step) : "",
      major: onMajor,
    });
  }
  return ticks;
}
