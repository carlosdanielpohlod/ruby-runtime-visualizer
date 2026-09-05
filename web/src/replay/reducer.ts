// Cursor and playback state. Pure, so it can be tested without React.

export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 10] as const;
export type Speed = (typeof SPEEDS)[number];

export interface ReplayState {
  cursorNs: number;
  playing: boolean;
  speed: Speed;
  startNs: number;
  endNs: number;
}

export type ReplayAction =
  | { type: "load"; startNs: number; endNs: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "seek"; ns: number }
  | { type: "jumpStart" }
  | { type: "jumpEnd" }
  | { type: "setSpeed"; speed: Speed }
  /** Advance by wall-clock time; `elapsedMs` is real time since the last tick. */
  | { type: "tick"; elapsedMs: number }
  /** Move to the next or previous event; `timestamps` are in sequence order. */
  | { type: "step"; direction: 1 | -1; timestamps: readonly number[] };

export const initialReplayState: ReplayState = {
  cursorNs: 0,
  playing: false,
  speed: 1,
  startNs: 0,
  endNs: 0,
};

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  switch (action.type) {
    case "load":
      return { ...state, startNs: action.startNs, endNs: action.endNs, cursorNs: action.startNs, playing: false };
    case "play":
      if (state.endNs <= state.startNs) return state;
      // Playing from the end restarts from the beginning, like a media player.
      return { ...state, playing: true, cursorNs: state.cursorNs >= state.endNs ? state.startNs : state.cursorNs };
    case "pause":
      return state.playing ? { ...state, playing: false } : state;
    case "toggle":
      return replayReducer(state, { type: state.playing ? "pause" : "play" });
    case "seek":
      return { ...state, cursorNs: clamp(action.ns, state.startNs, state.endNs) };
    case "jumpStart":
      return { ...state, cursorNs: state.startNs, playing: false };
    case "jumpEnd":
      return { ...state, cursorNs: state.endNs, playing: false };
    case "setSpeed":
      return { ...state, speed: action.speed };
    case "tick": {
      if (!state.playing) return state;
      const next = state.cursorNs + action.elapsedMs * 1e6 * state.speed;
      if (next >= state.endNs) return { ...state, cursorNs: state.endNs, playing: false };
      return { ...state, cursorNs: next };
    }
    case "step": {
      const target = stepTarget(state.cursorNs, action.direction, action.timestamps);
      if (target === null) return state;
      return { ...state, cursorNs: clamp(target, state.startNs, state.endNs), playing: false };
    }
  }
}

/** Index of the event the cursor is on: the last one at or before the cursor. */
export function currentEventIndex(cursorNs: number, timestamps: readonly number[]): number {
  let lo = 0;
  let hi = timestamps.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ts = timestamps[mid];
    if (ts !== undefined && ts <= cursorNs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function stepTarget(cursorNs: number, direction: 1 | -1, timestamps: readonly number[]): number | null {
  const index = currentEventIndex(cursorNs, timestamps);
  if (direction === 1) {
    // Skip events sharing the current timestamp so that a step always moves.
    let next = index + 1;
    while (next < timestamps.length && timestamps[next] === cursorNs) next += 1;
    const ts = timestamps[next];
    return ts === undefined ? null : ts;
  }
  // Stepping back from between two events snaps to the current one first.
  const current = timestamps[index];
  if (current !== undefined && current < cursorNs) return current;
  let previous = index - 1;
  while (previous >= 0 && timestamps[previous] === current) previous -= 1;
  const ts = timestamps[previous];
  return ts === undefined ? null : ts;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
