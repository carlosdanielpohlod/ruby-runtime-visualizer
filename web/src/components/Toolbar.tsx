import { STATE_FILL } from "../timeline/colors";
import { formatDuration } from "../timeline/format";
import type { LaneView } from "../timeline/rows";
import type { TimeRange } from "../timeline/selection";
import { THREAD_STATES } from "../model/timeline";

interface ToolbarProps {
  view: LaneView;
  onViewChange: (view: LaneView) => void;
  hasRecorderThread: boolean;
  showRecorder: boolean;
  onShowRecorderChange: (show: boolean) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  range: TimeRange | null;
  onZoomToRange: () => void;
  onClearRange: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const { view, onViewChange, hasRecorderThread, showRecorder, onShowRecorderChange, onZoomIn, onZoomOut, onFit, range, onZoomToRange, onClearRange } = props;
  return (
    <div className="toolbar">
      <div className="segmented" role="group" aria-label="Lane view">
        <button type="button" className={view === "ruby" ? "active" : undefined} aria-pressed={view === "ruby"} onClick={() => onViewChange("ruby")}>
          Ruby threads
        </button>
        <button type="button" className={view === "native" ? "active" : undefined} aria-pressed={view === "native"} onClick={() => onViewChange("native")}>
          Native threads
        </button>
      </div>
      {hasRecorderThread && (
        <label className="check">
          <input type="checkbox" checked={showRecorder} onChange={(event) => onShowRecorderChange(event.target.checked)} />
          show recorder thread
        </label>
      )}
      <div className="toolbar-group">
        <button type="button" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in (+)">
          +
        </button>
        <button type="button" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out (-)">
          −
        </button>
        <button type="button" onClick={onFit} title="Fit whole trace (0)">
          Fit
        </button>
        {range && (
          <>
            <button type="button" onClick={onZoomToRange} title="Zoom to the selected range">
              Zoom to {formatDuration(range.endNs - range.startNs)}
            </button>
            <button type="button" onClick={onClearRange} aria-label="Clear selected range" title="Clear selection (Esc)">
              ×
            </button>
          </>
        )}
      </div>
      <Legend />
      <span className="hint">ctrl/⌘ + wheel zoom · shift + wheel pan · drag pan · shift + drag select · click sets cursor</span>
    </div>
  );
}

function Legend() {
  return (
    <ul className="legend" aria-label="State legend">
      {THREAD_STATES.map((state) => (
        <li key={state}>
          <span className={`swatch${state === "PREEMPTED" ? " striped" : ""}`} style={{ background: STATE_FILL[state] }} />
          {state}
        </li>
      ))}
      <li>
        <span className="swatch hatched" />
        derived
      </li>
      <li>
        <span className="swatch dashed" />
        inferred
      </li>
      <li>
        <span className="swatch gc" />
        GC
      </li>
    </ul>
  );
}
