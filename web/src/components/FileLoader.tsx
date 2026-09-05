import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { formatBytes, formatCount } from "../timeline/format";
import type { LoaderState } from "./useTraceLoader";

const SAMPLES = [
  { name: "cpu_threads.rvtrace", load: () => import("../__fixtures__/cpu_threads.rvtrace?raw") },
  { name: "sleep.rvtrace", load: () => import("../__fixtures__/sleep.rvtrace?raw") },
  { name: "mutex.rvtrace", load: () => import("../__fixtures__/mutex.rvtrace?raw") },
  { name: "sleep_ruby32.rvtrace", load: () => import("../__fixtures__/sleep_ruby32.rvtrace?raw") },
];

interface OpenTraceButtonProps {
  onFile: (file: File) => void;
  className?: string;
}

export function OpenTraceButton({ onFile, className }: OpenTraceButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file) onFile(file);
    event.target.value = "";
  };
  return (
    <>
      <button type="button" className={className} onClick={() => inputRef.current?.click()}>
        Open trace…
      </button>
      <input ref={inputRef} type="file" accept=".rvtrace,.ndjson,.jsonl,application/x-ndjson" hidden onChange={onChange} aria-label="Choose a trace file" />
    </>
  );
}

interface EmptyStateProps {
  state: LoaderState;
  onFile: (file: File) => void;
  onText: (text: string, name: string) => void;
}

export function EmptyState({ state, onFile, onText }: EmptyStateProps) {
  const loadSample = async (sample: (typeof SAMPLES)[number]): Promise<void> => {
    const module = await sample.load();
    onText(module.default, sample.name);
  };
  return (
    <section className="empty-state">
      <div className="empty-card">
        <h2>Load a trace</h2>
        <p>Drop an .rvtrace file anywhere on this page, pick one with the button, or open the app with ?trace=&lt;url&gt;.</p>
        <p className="row">
          <OpenTraceButton onFile={onFile} className="primary" />
        </p>
        {state.status === "loading" && <Progress state={state} />}
        {state.status === "error" && <p className="error">Could not load the trace: {state.message}</p>}
        <h3>Producing a trace</h3>
        <pre>
          {"runtime-visualizer trace script.rb          # writes script.rvtrace\n"}
          {"runtime-visualizer trace --lines script.rb  # also records source lines (high overhead)"}
        </pre>
        <p className="muted">
          The recorder listens to CRuby's internal thread events (RUBY_INTERNAL_THREAD_EVENT_*), GC tracepoints and a few probes. What the runtime
          did not report is never invented: every segment carries its precision.
        </p>
        <h3>Sample traces</h3>
        <p className="row">
          {SAMPLES.map((sample) => (
            <button key={sample.name} type="button" onClick={() => void loadSample(sample)}>
              {sample.name}
            </button>
          ))}
        </p>
      </div>
    </section>
  );
}

function Progress({ state }: { state: Extract<LoaderState, { status: "loading" }> }) {
  const { progress } = state;
  const ratio = progress && progress.bytesTotal ? progress.bytesRead / progress.bytesTotal : null;
  return (
    <div className="progress" role="status">
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${ratio === null ? 100 : Math.round(ratio * 100)}%` }} />
      </div>
      <span>
        Reading {state.name}
        {progress ? ` · ${formatBytes(progress.bytesRead)}${progress.bytesTotal ? ` of ${formatBytes(progress.bytesTotal)}` : ""} · ${formatCount(progress.lines)} lines` : ""}
      </span>
    </div>
  );
}

/** Full-window drag-and-drop: shows an overlay while a file is dragged over the page. */
export function useFileDrop(onFile: (file: File) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent): void => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDragLeave = (): void => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = event.dataTransfer?.files[0];
      if (file) onFile(file);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFile]);
  return dragging;
}
