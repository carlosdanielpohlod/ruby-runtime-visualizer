// Pixel layout shared by the ruler, the lanes and hit testing.

export const LABEL_WIDTH = 176;
export const RULER_HEIGHT = 28;
export const LANE_HEIGHT = 34;
export const GVL_LANE_HEIGHT = 26;
/** Vertical inset of state rectangles inside a lane. */
export const SEGMENT_INSET = 7;
/** Height of the marker band at the bottom of a thread lane. */
export const TICK_BAND = 7;
export const GC_BAND = 3;
/** Approximate advance of one character of the 10px monospace lane font. */
export const CHAR_WIDTH = 6.1;

export function labelThatFits(label: string, width: number): string | null {
  const capacity = Math.floor((width - 6) / CHAR_WIDTH);
  if (capacity >= label.length) return label;
  if (capacity < 3) return null;
  return label.slice(0, capacity - 1) + "…";
}
