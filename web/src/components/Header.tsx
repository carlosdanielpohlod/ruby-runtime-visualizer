import type { TraceModel } from "../model";
import { TRACE_MODE_NOTICE } from "../protocol/catalog";
import { formatCount, formatDuration } from "../timeline/format";
import { OpenTraceButton } from "./FileLoader";

interface HeaderProps {
  model: TraceModel | null;
  onFile: (file: File) => void;
}

export function Header({ model, onFile }: HeaderProps) {
  const trace = model?.trace;
  const header = trace?.header;
  const stats = trace?.stats;
  const dropped = stats?.events_dropped ?? 0;
  const violations = model?.timeline.violations.length ?? 0;
  return (
    <header className="app-header">
      <h1>Ruby Runtime Visualizer</h1>
      {trace && header && (
        <div className="trace-meta">
          <span className="trace-name" title={header.script ?? trace.name}>
            {trace.name}
          </span>
          <span className="sep">·</span>
          <span>
            {header.ruby_engine ?? "ruby"} {header.ruby_version ?? "?"}
            {header.ruby_platform ? ` (${header.ruby_platform})` : ""}
          </span>
          <span className="sep">·</span>
          <span>pid {header.process_id ?? "?"}</span>
          {header.scheduler?.mn_threads && <span className="badge">M:N threads</span>}
          <span className="chips" aria-label="Enabled channels">
            {(header.channels ?? []).map((channel) => (
              <span key={channel} className="chip">
                {channel}
              </span>
            ))}
          </span>
        </div>
      )}
      <div className="header-right">
        {trace && stats && (
          <dl className="stats">
            <div>
              <dt>events</dt>
              <dd>{formatCount(stats.events_recorded ?? trace.events.length)}</dd>
            </div>
            <div className={dropped > 0 ? "alert" : undefined}>
              <dt>dropped</dt>
              <dd>{formatCount(dropped)}</dd>
            </div>
            <div>
              <dt>buffer high water</dt>
              <dd>
                {formatCount(stats.buffer_high_water_mark ?? 0)}
                {stats.buffer_capacity ? ` / ${formatCount(stats.buffer_capacity)}` : ""}
              </dd>
            </div>
            <div>
              <dt>duration</dt>
              <dd>{formatDuration(trace.endNs - trace.startNs)}</dd>
            </div>
          </dl>
        )}
        {trace && !trace.complete && (
          <span className="badge warn" title="The file ended before its end record. The tail of the trace is missing.">
            incomplete trace
          </span>
        )}
        {trace && trace.malformedLines > 0 && (
          <span className="badge warn" title="Lines that were not valid records were skipped.">
            {trace.malformedLines} malformed lines
          </span>
        )}
        {violations > 0 && (
          <span className="badge alert" title="gvl_acquired seen while the same thread already owned the GVL. Either a recorder bug or CRuby behaviour not modelled.">
            {violations} GVL violation{violations > 1 ? "s" : ""}
          </span>
        )}
        {trace && (
          <span className="trace-mode" tabIndex={0} aria-describedby="trace-mode-notice">
            <span className="badge">TRACE MODE</span>
            <span className="popover" role="tooltip" id="trace-mode-notice">
              {TRACE_MODE_NOTICE}
            </span>
          </span>
        )}
        <OpenTraceButton onFile={onFile} />
      </div>
    </header>
  );
}
