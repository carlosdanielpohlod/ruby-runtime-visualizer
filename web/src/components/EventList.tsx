import { useEffect, useMemo, useRef, useState } from "react";
import type { TraceModel } from "../model";
import { threadLabel, type TraceEvent } from "../protocol/types";
import { currentEventIndex } from "../replay/reducer";
import { threadColor } from "../timeline/colors";
import { formatCount, formatTime } from "../timeline/format";
import type { Selection } from "../timeline/selection";

interface EventListProps {
  model: TraceModel;
  cursorNs: number;
  selection: Selection | null;
  threadColors: Map<number, string>;
  onSelectEvent: (event: TraceEvent) => void;
}

const ROW_HEIGHT = 22;
const OVERSCAN = 10;

export function EventList({ model, cursorNs, selection, threadColors, onSelectEvent }: EventListProps) {
  const { trace } = model;
  const [hideSourceLines, setHideSourceLines] = useState(true);
  const [follow, setFollow] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const bodyRef = useRef<HTMLDivElement>(null);

  const hasSourceLines = model.source.hasLineEvents;
  const events = useMemo(
    () => (hideSourceLines && hasSourceLines ? trace.events.filter((e) => e.type !== "source_line") : trace.events),
    [trace, hideSourceLines, hasSourceLines],
  );
  const timestamps = useMemo(() => events.map((e) => e.timestamp_ns), [events]);
  const currentIndex = currentEventIndex(cursorNs, timestamps);
  const selectedSequence = selection?.kind === "event" ? selection.event.sequence : null;

  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setHeight(entries[0]?.contentRect.height ?? 300));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Keep the current event in view as the cursor moves; the user can pause that.
  useEffect(() => {
    const element = bodyRef.current;
    if (!follow || !element || currentIndex < 0) return;
    const rowTop = currentIndex * ROW_HEIGHT;
    if (rowTop < element.scrollTop || rowTop + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, rowTop - element.clientHeight / 2);
    }
  }, [currentIndex, follow]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(events.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const visible = events.slice(first, last);

  return (
    <div className="event-list">
      <div className="panel-header">
        <h2>Events</h2>
        <span className="muted">
          {formatCount(events.length)}
          {events.length !== trace.events.length ? ` of ${formatCount(trace.events.length)}` : ""}
        </span>
        {hasSourceLines && (
          <label className="check">
            <input type="checkbox" checked={hideSourceLines} onChange={(e) => setHideSourceLines(e.target.checked)} />
            hide source_line
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          follow cursor
        </label>
      </div>
      <div className="event-columns" aria-hidden="true">
        <span>seq</span>
        <span>time</span>
        <span>thread</span>
        <span>type</span>
        <span>native event</span>
      </div>
      <div className="event-body" ref={bodyRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} role="listbox" aria-label="Events">
        <div style={{ height: events.length * ROW_HEIGHT, position: "relative" }}>
          {visible.map((event, offset) => {
            const index = first + offset;
            const classes = ["event-row"];
            if (index === currentIndex) classes.push("current");
            if (event.sequence === selectedSequence) classes.push("selected");
            if (index > currentIndex) classes.push("future");
            return (
              <div
                key={event.sequence}
                className={classes.join(" ")}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                role="option"
                aria-selected={event.sequence === selectedSequence}
                tabIndex={-1}
                onClick={() => onSelectEvent(event)}
              >
                <span className="col-seq">{event.sequence}</span>
                <span className="col-time">{formatTime(event.timestamp_ns - trace.startNs)}</span>
                <span className="col-thread">
                  <span className="swatch" style={{ background: threadColor(threadColors, event.ruby_thread_id) }} />
                  {threadLabel(trace, event.ruby_thread_id)}
                </span>
                <span className="col-type">{event.type}</span>
                <span className="col-native">{event.native_event ?? ""}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
