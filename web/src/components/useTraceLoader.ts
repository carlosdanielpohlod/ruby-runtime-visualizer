import { useCallback, useState } from "react";
import { buildTraceModel, type TraceModel } from "../model";
import { parseTrace, parseTraceStream, type LoadProgress } from "../protocol/parser";

export type LoaderState =
  | { status: "empty" }
  | { status: "loading"; name: string; progress: LoadProgress | null }
  | { status: "ready"; model: TraceModel }
  | { status: "error"; message: string };

export interface TraceLoader {
  state: LoaderState;
  loadFile: (file: File) => void;
  loadUrl: (url: string) => void;
  loadText: (text: string, name: string) => void;
}

export function useTraceLoader(): TraceLoader {
  const [state, setState] = useState<LoaderState>({ status: "empty" });

  const run = useCallback(async (name: string, produce: () => Promise<TraceModel>) => {
    setState({ status: "loading", name, progress: null });
    try {
      setState({ status: "ready", model: await produce() });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const loadFile = useCallback(
    (file: File) => {
      void run(file.name, async () => {
        const trace = await parseTraceStream(file.stream(), file.name, file.size, (progress) =>
          setState({ status: "loading", name: file.name, progress }),
        );
        return buildTraceModel(trace);
      });
    },
    [run],
  );

  const loadUrl = useCallback(
    (url: string) => {
      const name = url.split("/").pop() || url;
      void run(name, async () => {
        const response = await fetch(url);
        if (!response.ok || !response.body) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
        const length = response.headers.get("content-length");
        const trace = await parseTraceStream(response.body, name, length ? Number(length) : null, (progress) =>
          setState({ status: "loading", name, progress }),
        );
        return buildTraceModel(trace);
      });
    },
    [run],
  );

  const loadText = useCallback(
    (text: string, name: string) => {
      void run(name, async () => buildTraceModel(parseTrace(text, name)));
    },
    [run],
  );

  return { state, loadFile, loadUrl, loadText };
}
