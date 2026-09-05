import { currentEventIndex, SPEEDS, type ReplayAction, type ReplayState } from "../replay/reducer";
import { formatCount, formatTime } from "../timeline/format";

interface TransportProps {
  replay: ReplayState;
  dispatch: (action: ReplayAction) => void;
  eventTimestamps: number[];
  originNs: number;
}

export function Transport({ replay, dispatch, eventTimestamps, originNs }: TransportProps) {
  const index = currentEventIndex(replay.cursorNs, eventTimestamps);
  const step = (direction: 1 | -1): void => dispatch({ type: "step", direction, timestamps: eventTimestamps });
  return (
    <footer className="transport">
      <div className="toolbar-group">
        <button type="button" onClick={() => dispatch({ type: "jumpStart" })} aria-label="Jump to start" title="Jump to start (Home)">
          |◀
        </button>
        <button type="button" onClick={() => step(-1)} aria-label="Previous event" title="Previous event (←)">
          ◀
        </button>
        <button type="button" className="primary" onClick={() => dispatch({ type: "toggle" })} aria-label={replay.playing ? "Pause" : "Play"} title="Play / pause (space)">
          {replay.playing ? "❚❚" : "▶"}
        </button>
        <button type="button" onClick={() => step(1)} aria-label="Next event" title="Next event (→)">
          ▶
        </button>
        <button type="button" onClick={() => dispatch({ type: "jumpEnd" })} aria-label="Jump to end" title="Jump to end (End)">
          ▶|
        </button>
      </div>
      <div className="segmented" role="group" aria-label="Playback speed">
        {SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            className={replay.speed === speed ? "active" : undefined}
            aria-pressed={replay.speed === speed}
            onClick={() => dispatch({ type: "setSpeed", speed })}
          >
            {speed}x
          </button>
        ))}
      </div>
      <span className="readout">
        cursor <strong>{formatTime(replay.cursorNs - originNs)}</strong>
      </span>
      <span className="readout muted">
        event {index < 0 ? "—" : formatCount(index + 1)} / {formatCount(eventTimestamps.length)}
      </span>
    </footer>
  );
}
