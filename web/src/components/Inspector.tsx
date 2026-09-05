import type { ReactNode } from "react";
import type { TraceModel } from "../model";
import { gvlSegmentAt, segmentAt, type GvlSegment, type Segment } from "../model/timeline";
import { EVENT_MEANINGS, NATIVE_THREAD_ROLE_MEANINGS, PRECISION_MEANINGS, STATE_MEANINGS } from "../protocol/catalog";
import { isGcEvent, isProbeEvent, isRecorderEvent, isSchedulerEvent, threadLabel, type TraceEvent } from "../protocol/types";
import { STATE_FILL, threadColor } from "../timeline/colors";
import { formatDuration, formatTime } from "../timeline/format";
import type { LaneView } from "../timeline/rows";
import type { Selection } from "../timeline/selection";
import { nativeThreadOf } from "../timeline/Timeline";

interface InspectorProps {
  model: TraceModel;
  selection: Selection | null;
  cursorNs: number;
  view: LaneView;
  threadColors: Map<number, string>;
  onSelectEvent: (event: TraceEvent) => void;
}

export function Inspector({ model, selection, cursorNs, view, threadColors, onSelectEvent }: InspectorProps) {
  return (
    <div className="inspector">
      <h2>Inspector</h2>
      {selection ? (
        <SelectionCard model={model} selection={selection} onSelectEvent={onSelectEvent} />
      ) : (
        <p className="muted">Click a segment, a marker or an event to see where it came from.</p>
      )}
      <AtCursor model={model} cursorNs={cursorNs} view={view} threadColors={threadColors} />
    </div>
  );
}

function SelectionCard({ model, selection, onSelectEvent }: { model: TraceModel; selection: Selection; onSelectEvent: (event: TraceEvent) => void }) {
  switch (selection.kind) {
    case "segment":
      return <SegmentCard model={model} segment={selection.segment} onSelectEvent={onSelectEvent} />;
    case "gvl":
      return <GvlCard model={model} segment={selection.segment} onSelectEvent={onSelectEvent} />;
    case "event":
      return <EventCard model={model} event={selection.event} />;
    case "dense":
      return (
        <section className="card">
          <h3>{selection.count} segments merged</h3>
          <Field label="Lane">{selection.laneLabel}</Field>
          <Field label="Start">{formatTime(selection.startNs - model.trace.startNs)}</Field>
          <Field label="Duration">{formatDuration(selection.endNs - selection.startNs)}</Field>
          <p className="muted">Each segment is narrower than one pixel at this zoom level. Zoom in to inspect them individually.</p>
        </section>
      );
  }
}

function SegmentCard({ model, segment, onSelectEvent }: { model: TraceModel; segment: Segment; onSelectEvent: (event: TraceEvent) => void }) {
  const { trace } = model;
  const origin = trace.startNs;
  const opening = segment.sequence > 0 ? eventBySequence(model, segment.sequence) : null;
  const nativeId = nativeThreadOf(model, segment.sequence, segment.rubyThreadId);
  const firstEvent = trace.events.find((e) => e.ruby_thread_id === segment.rubyThreadId);
  return (
    <section className="card">
      <h3>
        <span className="swatch" style={{ background: STATE_FILL[segment.state] }} />
        {segment.state}
        <PrecisionBadge precision={segment.precision} />
      </h3>
      <p className="meaning">{STATE_MEANINGS[segment.state]}</p>
      <Field label="Ruby thread">
        {threadLabel(trace, segment.rubyThreadId)} (#{segment.rubyThreadId})
      </Field>
      <Field label="Native thread">
        {nativeId === null ? "unknown" : `tid ${nativeId}`}
        {" — "}
        {nativeThreadNote(segment, opening?.metadata.native_thread_role)}
      </Field>
      <Field label="Start">
        {formatTime(segment.startNs - origin)} <span className="muted">(abs {segment.startNs} ns)</span>
      </Field>
      <Field label="End">{formatTime(segment.endNs - origin)}</Field>
      <Field label="Duration">{formatDuration(segment.endNs - segment.startNs)}</Field>
      <Field label="Precision">{PRECISION_MEANINGS[segment.precision]}</Field>

      {segment.precision === "derived" && segment.derivedFrom && (
        <Field label="Derived from">
          SUSPENDED interval enclosed by {segment.derivedFrom.state === "SLEEPING" ? "Kernel#sleep" : "Thread::Mutex#lock"} probe events{" "}
          <SequenceLink model={model} sequence={segment.derivedFrom.enterSequence} onSelectEvent={onSelectEvent} /> and{" "}
          <SequenceLink model={model} sequence={segment.derivedFrom.exitSequence} onSelectEvent={onSelectEvent} /> on the same thread. CRuby only reported
          RUBY_INTERNAL_THREAD_EVENT_SUSPENDED; the reason comes from the probe.
        </Field>
      )}
      {segment.state === "PREEMPTED" && (
        <Field label="Derived from">
          {threadLabel(trace, segment.preemptedBy ?? 0)}'s gvl_acquired (<SequenceLink model={model} sequence={segment.sequence} onSelectEvent={onSelectEvent} />) closed this
          thread's RUNNING without a gvl_released from it. The state until this thread's next event is a derived gap.
        </Field>
      )}
      {segment.precision === "inferred" && (
        <Field label="Inferred from">
          This thread's first event in the trace is{" "}
          {firstEvent ? (
            <>
              <SequenceLink model={model} sequence={firstEvent.sequence} onSelectEvent={onSelectEvent} /> ({firstEvent.type})
            </>
          ) : (
            "unknown"
          )}
          , not thread_started, so the thread was alive before tracing began. Rule: RUNNING if the first event is gvl_released, SUSPENDED if wants_gvl, otherwise
          UNKNOWN.
        </Field>
      )}
      {opening && (
        <>
          <h4>Opened by</h4>
          <EventDetails model={model} event={opening} onSelectEvent={onSelectEvent} />
        </>
      )}
    </section>
  );
}

function GvlCard({ model, segment, onSelectEvent }: { model: TraceModel; segment: GvlSegment; onSelectEvent: (event: TraceEvent) => void }) {
  const { trace } = model;
  const opening = segment.sequence > 0 ? eventBySequence(model, segment.sequence) : null;
  return (
    <section className="card">
      <h3>
        GVL {segment.owner === null ? "idle" : `owned by ${threadLabel(trace, segment.owner)}`}
        <PrecisionBadge precision={segment.precision} />
      </h3>
      <p className="meaning">
        {segment.owner === null
          ? "No thread had an open gvl_acquired: the last owner released the lock or exited and nobody acquired it yet."
          : "The latest gvl_acquired whose thread had not released or exited since. Observed at the endpoints, derived for the interval between them."}
      </p>
      <Field label="Start">{formatTime(segment.startNs - trace.startNs)}</Field>
      <Field label="Duration">{formatDuration(segment.endNs - segment.startNs)}</Field>
      {opening ? (
        <>
          <h4>Opened by</h4>
          <EventDetails model={model} event={opening} onSelectEvent={onSelectEvent} />
        </>
      ) : (
        <Field label="Opened by">trace start</Field>
      )}
    </section>
  );
}

function EventCard({ model, event }: { model: TraceModel; event: TraceEvent }) {
  return (
    <section className="card">
      <h3>
        {eventKindTitle(event)}
        <PrecisionBadge precision={event.precision} />
      </h3>
      <EventDetails model={model} event={event} onSelectEvent={null} />
    </section>
  );
}

function EventDetails({ model, event, onSelectEvent }: { model: TraceModel; event: TraceEvent; onSelectEvent: ((event: TraceEvent) => void) | null }) {
  const { trace } = model;
  const meaning = EVENT_MEANINGS[event.type];
  const role = event.metadata.native_thread_role;
  const extras = Object.entries(event.metadata).filter(([key]) => key !== "native_thread_role");
  return (
    <dl className="fields">
      <Field label="Event">
        seq {event.sequence} · {event.type}
        {onSelectEvent && (
          <>
            {" "}
            <button type="button" className="link" onClick={() => onSelectEvent(event)}>
              show
            </button>
          </>
        )}
      </Field>
      <Field label="Native event">{event.native_event ?? meaning?.nativeEvent ?? "none (recorder)"}</Field>
      <Field label="Meaning">{meaning?.meaning ?? "Unknown event type; kept verbatim from the file."}</Field>
      <Field label="Observed">{event.precision === "observed" ? "yes — the callback ran at this timestamp" : event.precision}</Field>
      <Field label="Timestamp">
        {formatTime(event.timestamp_ns - trace.startNs)} <span className="muted">(abs {event.timestamp_ns} ns, {trace.header.clock ?? "monotonic"})</span>
      </Field>
      <Field label="Ruby thread">
        {threadLabel(trace, event.ruby_thread_id)} (#{event.ruby_thread_id})
      </Field>
      <Field label="Native thread">{event.native_thread_id === null ? "unknown" : `tid ${event.native_thread_id}`}</Field>
      {role && (
        <Field label="native_thread_role">
          {role} — {NATIVE_THREAD_ROLE_MEANINGS[role]}
        </Field>
      )}
      <Field label="Source channel">{event.source}</Field>
      <Field label="Ractor">{event.ractor_id === null ? "null (unknown)" : event.ractor_id}</Field>
      {extras.map(([key, value]) => (
        <Field key={key} label={`metadata.${key}`}>
          {key === "path_id" && typeof value === "number" ? `${value} → ${trace.sourceFiles.get(value)?.path ?? "unknown file"}` : JSON.stringify(value)}
        </Field>
      ))}
    </dl>
  );
}

function AtCursor({ model, cursorNs, view, threadColors }: { model: TraceModel; cursorNs: number; view: LaneView; threadColors: Map<number, string> }) {
  const { trace, timeline } = model;
  const gvl = gvlSegmentAt(timeline.gvlSegments, cursorNs);
  return (
    <section className="card at-cursor">
      <h3>At cursor · {formatTime(cursorNs - trace.startNs)}</h3>
      <Field label="GVL owner">
        {gvl === null || gvl.owner === null ? (
          <span className="muted">idle</span>
        ) : (
          <>
            <span className="swatch" style={{ background: threadColor(threadColors, gvl.owner) }} />
            {threadLabel(trace, gvl.owner)}
          </>
        )}
      </Field>
      <div className="table-scroll">
      <table className="thread-states">
        <thead>
          <tr>
            <th>thread</th>
            <th>state</th>
            <th>since</th>
            <th>precision</th>
          </tr>
        </thead>
        <tbody>
          {model.threadLanes.map((lane) => {
            const segment = segmentAt(timeline.threadSegments.get(lane.rubyThreadId) ?? [], cursorNs);
            return (
              <tr key={lane.rubyThreadId}>
                <td>
                  <span className="swatch" style={{ background: threadColor(threadColors, lane.rubyThreadId) }} />
                  {lane.label}
                  {lane.isRecorder && <span className="muted"> (recorder)</span>}
                </td>
                <td>
                  {segment ? (
                    <span className="state-chip" style={{ background: STATE_FILL[segment.state] }}>
                      {segment.state}
                    </span>
                  ) : (
                    <span className="muted">not yet started / exited</span>
                  )}
                </td>
                <td>{segment ? formatTime(segment.startNs - trace.startNs) : "—"}</td>
                <td>{segment ? segment.precision : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {view === "native" && (
        <p className="muted">
          Native view: only RUNNING is placed on a native thread, because gvl_acquired is the one callback known to run on the thread that owns the lock.
          Other callbacks may run on a creator, a waker or the timer thread.
        </p>
      )}
    </section>
  );
}

function SequenceLink({ model, sequence, onSelectEvent }: { model: TraceModel; sequence: number; onSelectEvent: (event: TraceEvent) => void }) {
  const event = eventBySequence(model, sequence);
  if (!event) return <>seq {sequence}</>;
  return (
    <button type="button" className="link" onClick={() => onSelectEvent(event)}>
      seq {sequence} ({event.type})
    </button>
  );
}

// How sure we are that the native thread of the opening callback is the
// Ruby thread's own. Only gvl_acquired is guaranteed to run on the owner.
function nativeThreadNote(segment: Segment, role: string | undefined): string {
  if (segment.sequence === 0) return "first native thread seen for this Ruby thread (inferred segment)";
  if (segment.state === "PREEMPTED") return "native thread of the other thread's gvl_acquired; this thread's own is unknown here";
  if (segment.state === "RUNNING") return "certain: gvl_acquired runs on the thread that now owns the lock";
  switch (role) {
    case "self":
      return "the callback ran on this Ruby thread's own native thread (native_thread_role self)";
    case "creator":
      return "the callback ran on the creating thread, not this one (native_thread_role creator)";
    default:
      return "thread that ran the callback; could be a waker or the timer thread (native_thread_role unknown)";
  }
}

function PrecisionBadge({ precision }: { precision: string }) {
  return <span className={`badge precision-${precision}`}>{precision}</span>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function eventKindTitle(event: TraceEvent): string {
  if (isSchedulerEvent(event.type)) return `CRuby internal event: ${event.native_event ?? EVENT_MEANINGS[event.type]?.nativeEvent ?? event.type}`;
  if (isGcEvent(event.type)) return `GC tracepoint: ${event.native_event ?? event.type}`;
  if (isProbeEvent(event.type)) return `Probe: ${event.native_event ?? event.type} (${event.type})`;
  if (event.type === "source_line") return "TracePoint :line";
  if (isRecorderEvent(event.type)) return `Recorder: ${event.type}`;
  return `Event: ${event.type}`;
}

function eventBySequence(model: TraceModel, sequence: number): TraceEvent | null {
  const direct = model.trace.events[sequence - 1];
  if (direct && direct.sequence === sequence) return direct;
  return model.trace.events.find((e) => e.sequence === sequence) ?? null;
}
