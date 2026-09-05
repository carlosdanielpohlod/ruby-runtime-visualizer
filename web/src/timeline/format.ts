// Human units for nanosecond quantities.

interface Unit {
  suffix: string;
  ns: number;
}

const UNITS: readonly Unit[] = [
  { suffix: "s", ns: 1e9 },
  { suffix: "ms", ns: 1e6 },
  { suffix: "µs", ns: 1e3 },
  { suffix: "ns", ns: 1 },
];

export function unitFor(ns: number): Unit {
  const magnitude = Math.abs(ns);
  return UNITS.find((u) => magnitude >= u.ns) ?? UNITS[UNITS.length - 1]!;
}

/** Three significant digits with an auto unit: "1.21 s", "21.2 ms", "812 µs", "34 ns". */
export function formatDuration(ns: number): string {
  if (ns === 0) return "0 ns";
  const unit = unitFor(ns);
  const value = ns / unit.ns;
  if (unit.ns === 1) return `${Math.round(value)} ns`;
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${trimZeros(value.toFixed(digits))} ${unit.suffix}`;
}

/** Time since trace start, in the given unit, with just enough decimals to tell steps of `stepNs` apart. */
export function formatTimeInUnit(ns: number, unit: Unit, stepNs: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(stepNs / unit.ns) + 1e-9));
  return `${(ns / unit.ns).toFixed(Math.min(decimals, 6))} ${unit.suffix}`;
}

/** Cursor readout: fixed unit chosen by the value, three decimals. */
export function formatTime(ns: number): string {
  const unit = unitFor(ns);
  if (unit.ns === 1) return `${Math.round(ns)} ns`;
  return `${(ns / unit.ns).toFixed(3)} ${unit.suffix}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}
