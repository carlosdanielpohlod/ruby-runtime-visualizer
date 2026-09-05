import { useEffect, useReducer } from "react";
import { initialReplayState, replayReducer, type ReplayAction, type ReplayState } from "./reducer";

/** Ticks with real elapsed time above this are clamped, so a background tab does not jump. */
const MAX_FRAME_MS = 100;

export function useReplay(): [ReplayState, (action: ReplayAction) => void] {
  const [state, dispatch] = useReducer(replayReducer, initialReplayState);

  useEffect(() => {
    if (!state.playing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number): void => {
      dispatch({ type: "tick", elapsedMs: Math.min(now - last, MAX_FRAME_MS) });
      last = now;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [state.playing]);

  return [state, dispatch];
}
