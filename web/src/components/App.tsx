import { useCallback, useEffect, useMemo, useState } from "react";
import type { TraceEvent } from "../protocol/types";
import { useReplay } from "../replay/useReplay";
import { buildThreadColors } from "../timeline/colors";
import type { LaneView } from "../timeline/rows";
import type { Selection, TimeRange } from "../timeline/selection";
import { Timeline } from "../timeline/Timeline";
import { ensureVisible, fitViewport, zoomAround, zoomToRange, type TimeBounds, type Viewport } from "../timeline/viewport";
import { EventList } from "./EventList";
import { EmptyState, useFileDrop } from "./FileLoader";
import { Header } from "./Header";
import { Inspector } from "./Inspector";
import { SourcePanel } from "./SourcePanel";
import { Toolbar } from "./Toolbar";
import { Transport } from "./Transport";
import { useKeyboardShortcuts, type Shortcuts } from "./useKeyboardShortcuts";
import { useTraceLoader } from "./useTraceLoader";

const ZOOM_STEP = 1.6;

export function App() {
  const loader = useTraceLoader();
  const model = loader.state.status === "ready" ? loader.state.model : null;
  const [replay, dispatch] = useReplay();
  const [view, setView] = useState<LaneView>("ruby");
  const [showRecorder, setShowRecorder] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ startNs: 0, endNs: 1, width: 800 });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [range, setRange] = useState<TimeRange | null>(null);
  const dragging = useFileDrop(loader.loadFile);

  const bounds: TimeBounds | null = useMemo(() => (model ? { startNs: model.trace.startNs, endNs: model.trace.endNs } : null), [model]);
  const threadColors = useMemo(() => buildThreadColors(model?.threadLanes.map((lane) => lane.rubyThreadId) ?? []), [model]);

  const { loadUrl } = loader;
  useEffect(() => {
    const url = new URLSearchParams(window.location.search).get("trace");
    if (url) loadUrl(url);
  }, [loadUrl]);

  useEffect(() => {
    if (!bounds) return;
    dispatch({ type: "load", startNs: bounds.startNs, endNs: bounds.endNs });
    setViewport((current) => fitViewport(bounds, current.width));
    setSelection(null);
    setRange(null);
  }, [bounds, dispatch]);

  useEffect(() => {
    if (bounds) setViewport((current) => ensureVisible(current, bounds, replay.cursorNs));
  }, [bounds, replay.cursorNs]);

  const zoomBy = useCallback(
    (factor: number) => {
      if (bounds) setViewport((current) => zoomAround(current, bounds, current.width / 2, factor));
    },
    [bounds],
  );

  const selectEvent = useCallback(
    (event: TraceEvent) => {
      setSelection({ kind: "event", event });
      dispatch({ type: "seek", ns: event.timestamp_ns });
    },
    [dispatch],
  );

  const shortcuts: Shortcuts | null = useMemo(
    () =>
      model && bounds
        ? {
            zoomIn: () => zoomBy(ZOOM_STEP),
            zoomOut: () => zoomBy(1 / ZOOM_STEP),
            fit: () => setViewport((current) => fitViewport(bounds, current.width)),
            step: (direction) => dispatch({ type: "step", direction, timestamps: model.eventTimestamps }),
            togglePlay: () => dispatch({ type: "toggle" }),
            jumpStart: () => dispatch({ type: "jumpStart" }),
            jumpEnd: () => dispatch({ type: "jumpEnd" }),
            escape: () => {
              setRange(null);
              setSelection(null);
            },
          }
        : null,
    [model, bounds, zoomBy, dispatch],
  );
  useKeyboardShortcuts(shortcuts);

  return (
    <div className="app">
      <Header model={model} onFile={loader.loadFile} />
      {model && bounds ? (
        <main className="workspace">
          <section className="panel source-pane" aria-label="Source">
            <SourcePanel model={model} cursorNs={replay.cursorNs} threadColors={threadColors} />
          </section>
          <section className="panel timeline-pane" aria-label="Timeline">
            <Toolbar
              view={view}
              onViewChange={setView}
              hasRecorderThread={model.threadLanes.some((lane) => lane.isRecorder)}
              showRecorder={showRecorder}
              onShowRecorderChange={setShowRecorder}
              onZoomIn={() => zoomBy(ZOOM_STEP)}
              onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
              onFit={() => setViewport((current) => fitViewport(bounds, current.width))}
              range={range}
              onZoomToRange={() => range && setViewport((current) => zoomToRange(current, bounds, range.startNs, range.endNs))}
              onClearRange={() => setRange(null)}
            />
            <Timeline
              model={model}
              view={view}
              showRecorder={showRecorder}
              threadColors={threadColors}
              viewport={viewport}
              onViewportChange={setViewport}
              cursorNs={replay.cursorNs}
              onSeek={(ns) => dispatch({ type: "seek", ns })}
              selection={selection}
              onSelect={setSelection}
              range={range}
              onRangeChange={setRange}
            />
          </section>
          <section className="panel inspector-pane" aria-label="Inspector">
            <Inspector model={model} selection={selection} cursorNs={replay.cursorNs} view={view} threadColors={threadColors} onSelectEvent={selectEvent} />
          </section>
          <section className="panel events-pane" aria-label="Event list">
            <EventList model={model} cursorNs={replay.cursorNs} selection={selection} threadColors={threadColors} onSelectEvent={selectEvent} />
          </section>
        </main>
      ) : (
        <EmptyState state={loader.state} onFile={loader.loadFile} onText={loader.loadText} />
      )}
      {model && <Transport replay={replay} dispatch={dispatch} eventTimestamps={model.eventTimestamps} originNs={model.trace.startNs} />}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          Drop the .rvtrace file to load it
        </div>
      )}
    </div>
  );
}
