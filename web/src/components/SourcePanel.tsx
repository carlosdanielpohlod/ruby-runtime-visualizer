import { useEffect, useMemo, useRef, useState } from "react";
import type { TraceModel } from "../model";
import { positionsAt, type SourcePosition } from "../model/sourcePositions";
import { threadLabel } from "../protocol/types";
import { threadColor } from "../timeline/colors";

interface SourcePanelProps {
  model: TraceModel;
  cursorNs: number;
  threadColors: Map<number, string>;
}

export function SourcePanel({ model, cursorNs, threadColors }: SourcePanelProps) {
  const { trace, source } = model;
  const [activePath, setActivePath] = useState<string | null>(null);
  const positions = useMemo(() => (source.hasLineEvents ? positionsAt(trace, source, cursorNs) : []), [trace, source, cursorNs]);

  const scriptFile = useMemo(() => {
    const script = trace.header.script;
    return source.files.find((f) => script && f.path.endsWith(script)) ?? source.files[0] ?? null;
  }, [trace, source]);
  const activeFile = source.files.find((f) => f.path === activePath) ?? scriptFile;

  if (!source.hasLineEvents) {
    return (
      <div className="source-panel">
        <div className="panel-header">
          <h2>Source</h2>
        </div>
        <p className="muted note">Source line tracing was off for this trace (run with --lines).</p>
      </div>
    );
  }

  const byPath = new Map<string, SourcePosition[]>();
  for (const position of positions) {
    const list = byPath.get(position.path) ?? [];
    list.push(position);
    byPath.set(position.path, list);
  }

  return (
    <div className="source-panel">
      <div className="panel-header">
        <h2>Source</h2>
      </div>
      <div className="file-tabs" role="tablist">
        {source.files.map((file) => (
          <button
            key={file.path}
            type="button"
            role="tab"
            aria-selected={file.path === activeFile?.path}
            className={file.path === activeFile?.path ? "active" : undefined}
            title={file.path}
            onClick={() => setActivePath(file.path)}
          >
            {basename(file.path)}
            {(byPath.get(file.path) ?? []).map((position) => (
              <span key={position.rubyThreadId} className="swatch" style={{ background: threadColor(threadColors, position.rubyThreadId) }} />
            ))}
          </button>
        ))}
      </div>
      {activeFile && (
        <CodeView
          key={activeFile.path}
          content={activeFile.content}
          positions={byPath.get(activeFile.path) ?? []}
          threadColors={threadColors}
          labelFor={(id) => threadLabel(trace, id)}
        />
      )}
    </div>
  );
}

interface CodeViewProps {
  content: string | null;
  positions: SourcePosition[];
  threadColors: Map<number, string>;
  labelFor: (rubyThreadId: number) => string;
}

function CodeView({ content, positions, threadColors, labelFor }: CodeViewProps) {
  const lines = useMemo(() => (content ?? "").split("\n"), [content]);
  const containerRef = useRef<HTMLDivElement>(null);
  const markedLines = new Map<number, SourcePosition[]>();
  for (const position of positions) markedLines.set(position.line, [...(markedLines.get(position.line) ?? []), position]);
  const focusLine = positions[0]?.line ?? null;

  useEffect(() => {
    if (focusLine === null) return;
    const element = containerRef.current?.querySelector<HTMLElement>(`[data-line="${focusLine}"]`);
    element?.scrollIntoView({ block: "nearest" });
  }, [focusLine]);

  if (content === null) {
    return <p className="muted note">The file content was not recorded in the trace; only line numbers are known.</p>;
  }
  return (
    <div className="code" ref={containerRef}>
      {lines.map((text, index) => {
        const lineNumber = index + 1;
        const marks = markedLines.get(lineNumber);
        return (
          <div key={lineNumber} className={marks ? "code-line marked" : "code-line"} data-line={lineNumber}>
            <span className="line-marks">
              {marks?.map((position) => (
                <span
                  key={position.rubyThreadId}
                  className="line-mark"
                  style={{ background: threadColor(threadColors, position.rubyThreadId) }}
                  title={`${labelFor(position.rubyThreadId)} last executed this line (seq ${position.event.sequence})`}
                >
                  {labelFor(position.rubyThreadId)}
                </span>
              ))}
            </span>
            <span className="line-number">{lineNumber}</span>
            <span className="line-text">{text}</span>
          </div>
        );
      })}
    </div>
  );
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}
