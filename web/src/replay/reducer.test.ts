import { describe, expect, it } from "vitest";
import { currentEventIndex, initialReplayState, replayReducer, type ReplayState } from "./reducer";

const loaded: ReplayState = replayReducer(initialReplayState, { type: "load", startNs: 1000, endNs: 2000 });
const timestamps = [1000, 1100, 1100, 1500, 1900];

describe("replayReducer", () => {
  it("resets the cursor to the start when a trace is loaded", () => {
    expect(loaded).toMatchObject({ cursorNs: 1000, playing: false, startNs: 1000, endNs: 2000 });
  });

  it("advances the cursor in real time times speed while playing", () => {
    let state = replayReducer(loaded, { type: "play" });
    state = replayReducer(state, { type: "tick", elapsedMs: 0.0001 });
    expect(state.cursorNs).toBeCloseTo(1100);
    state = replayReducer(state, { type: "setSpeed", speed: 10 });
    state = replayReducer(state, { type: "tick", elapsedMs: 0.00001 });
    expect(state.cursorNs).toBeCloseTo(1200);
  });

  it("ignores ticks while paused", () => {
    expect(replayReducer(loaded, { type: "tick", elapsedMs: 100 })).toBe(loaded);
  });

  it("stops at the end and restarts from the beginning on play", () => {
    let state = replayReducer(loaded, { type: "play" });
    state = replayReducer(state, { type: "tick", elapsedMs: 1000 });
    expect(state).toMatchObject({ cursorNs: 2000, playing: false });
    state = replayReducer(state, { type: "play" });
    expect(state).toMatchObject({ cursorNs: 1000, playing: true });
  });

  it("clamps seeks to the trace bounds", () => {
    expect(replayReducer(loaded, { type: "seek", ns: 5 }).cursorNs).toBe(1000);
    expect(replayReducer(loaded, { type: "seek", ns: 9999 }).cursorNs).toBe(2000);
    expect(replayReducer(loaded, { type: "seek", ns: 1234 }).cursorNs).toBe(1234);
  });

  it("toggles play and pause", () => {
    const playing = replayReducer(loaded, { type: "toggle" });
    expect(playing.playing).toBe(true);
    expect(replayReducer(playing, { type: "toggle" }).playing).toBe(false);
  });

  it("steps forward through events by sequence, skipping equal timestamps", () => {
    let state = replayReducer(loaded, { type: "step", direction: 1, timestamps });
    expect(state.cursorNs).toBe(1100);
    state = replayReducer(state, { type: "step", direction: 1, timestamps });
    expect(state.cursorNs).toBe(1500);
    state = replayReducer(state, { type: "step", direction: 1, timestamps });
    state = replayReducer(state, { type: "step", direction: 1, timestamps });
    expect(state.cursorNs).toBe(1900);
  });

  it("steps back to the current event first, then to the previous one", () => {
    let state = replayReducer(loaded, { type: "seek", ns: 1600 });
    state = replayReducer(state, { type: "step", direction: -1, timestamps });
    expect(state.cursorNs).toBe(1500);
    state = replayReducer(state, { type: "step", direction: -1, timestamps });
    expect(state.cursorNs).toBe(1100);
    state = replayReducer(state, { type: "step", direction: -1, timestamps });
    expect(state.cursorNs).toBe(1000);
    expect(replayReducer(state, { type: "step", direction: -1, timestamps })).toBe(state);
  });

  it("pauses when stepping or jumping", () => {
    const playing = replayReducer(loaded, { type: "play" });
    expect(replayReducer(playing, { type: "step", direction: 1, timestamps }).playing).toBe(false);
    expect(replayReducer(playing, { type: "jumpEnd" })).toMatchObject({ cursorNs: 2000, playing: false });
    expect(replayReducer(playing, { type: "jumpStart" })).toMatchObject({ cursorNs: 1000, playing: false });
  });
});

describe("currentEventIndex", () => {
  it("finds the last event at or before the cursor", () => {
    expect(currentEventIndex(999, timestamps)).toBe(-1);
    expect(currentEventIndex(1000, timestamps)).toBe(0);
    expect(currentEventIndex(1100, timestamps)).toBe(2);
    expect(currentEventIndex(1700, timestamps)).toBe(3);
    expect(currentEventIndex(5000, timestamps)).toBe(4);
  });
});
