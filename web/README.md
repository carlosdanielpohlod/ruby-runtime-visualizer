# Ruby Runtime Visualizer — web viewer

Interactive timeline for `.rvtrace` files: one lane per Ruby thread, a GVL
ownership lane, a native-thread view, replay controls, an event list and an
inspector that shows where every segment came from (observed, derived or
inferred). The state model is a port of `lib/runtime_visualizer/timeline.rb`
and is tested against segments produced by that Ruby implementation.

## Running

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
npm run build      # type-check + production bundle in dist/
```

## Loading a trace

- Drag an `.rvtrace` file anywhere onto the page.
- Use the **Open trace…** button.
- Open `http://localhost:5173/?trace=<url>`; the URL must be fetchable from
  the browser (same origin or CORS-enabled).
- The empty state has four small sample traces bundled from `src/__fixtures__`.

Traces are produced by the Ruby side:

```sh
runtime-visualizer trace script.rb           # writes script.rvtrace
runtime-visualizer trace --lines script.rb   # also records source lines
```

A file that ends before its `end` record (crash, truncation) still loads
and is flagged "incomplete trace".

## Controls

| Action | Mouse | Keyboard |
|---|---|---|
| Zoom around the pointer | ctrl / ⌘ + wheel (pinch) | `+` / `-` (around the centre) |
| Pan | drag the lanes, shift + wheel, horizontal trackpad scroll | |
| Fit the whole trace | **Fit** button | `0` |
| Select a time range | shift + drag on the lanes | `Esc` clears |
| Move the cursor | click on the ruler or the lanes, drag on the ruler | `←` / `→` step events, `Home` / `End` |
| Play / pause | transport buttons, speed 0.1x–10x | `Space` |
| Inspect | click a segment, a marker tick, a GVL block or an event row | |

Plain wheel scrolls the lane list vertically, as in Perfetto and Chrome
DevTools.

## Layout of `src/`

- `protocol/` — types for the file format, the incremental NDJSON parser and
  the catalogue of event meanings (taken from `docs/event-protocol.md`).
- `model/` — pure functions: thread state segments and GVL segments
  (`timeline.ts`), GC/probe/source-line markers, the native-thread view and
  source positions.
- `timeline/` — the SVG timeline: viewport math, ruler ticks, segment
  culling and merging, lane layout and hit testing, the React components.
- `replay/` — the cursor/playback reducer and its animation-frame hook.
- `components/` — app shell, header, toolbar, inspector, event list, source
  panel, transport, file loading.
- `__fixtures__/` — small real traces plus the segments the Ruby reference
  model produces for them (`expected/`).

## Rendering notes

Milestone 1 renders with SVG. It stays usable because of three rules in
`timeline/culling.ts` and `timeline/rows.ts`:

- only intervals intersecting the visible window are emitted (binary search
  on the start time);
- consecutive intervals narrower than one pixel are merged into a single
  "dense" block, so a lane never emits more than roughly `width` elements;
- point markers (probe boundaries, `source_line`, recorder notices) are
  bucketed by pixel column.

Measured in headless Chrome (1600×1000, lanes area ~1,400 px wide) by
dispatching shift+wheel pans and timing until the next two animation
frames; the probe's floor is two 60 Hz frames, so "33 ms" means the render
fitted in a single frame.

Synthetic trace, 100,003 events, 8 threads, ~100k state segments, 2.8 s:

| Visible window | `rect` / `line` elements in the lanes | Pan (median / max) |
|---|---|---|
| whole trace (2.8 s), everything merged | 1,753 / 2,037 | 52 ms / 65 ms |
| 800 ms, segments around 1 px | 7,698 / 956 | 144 ms / 155 ms |
| 200 ms | 3,378 / 298 | 71 ms / 87 ms |
| 70 ms | 1,527 / 109 | 33 ms / 33 ms |
| 20 ms and closer | ≤ 1,092 | 33 ms |

Synthetic trace, 300,001 events, 16 threads, ~300k segments, 8 s:

| Visible window | `rect` / `line` elements | Pan (median / max) |
|---|---|---|
| whole trace (8 s) | 825 / 4,661 | 125 ms / 143 ms |
| 2 s | 9,978 / 2,000 | 213 ms / 221 ms |
| 700 ms | 10,494 / 883 | 203 ms / 210 ms |
| 200 ms | 4,311 / 292 | 89 ms / 93 ms |
| 60 ms | 1,476 / 113 | 37 ms / 46 ms |
| 18 ms | 1,010 / 52 | 33 ms |

Loading (fetch excluded): parsing the 30 MB / 100k-event file takes about
0.6 s and building the model 85 ms; the 12 MB / 45k-event `--lines` trace
parses in 0.2 s.

What this says about the SVG approach:

- Up to roughly 3,000 elements in the lanes a pan or zoom step renders in one
  frame. This covers traces of a few threads at every zoom level, because
  merging bounds the element count by lane width, not by segment count.
- Between 3,000 and 5,000 elements a step costs two to three frames: still
  fine for interaction, noticeable during continuous panning.
- Above ~8,000 elements — 8+ lanes whose segments are all about a pixel wide,
  or 16 lanes with a few thousand ticks — a step costs 150–220 ms. That is
  the point where the lanes should move to a Canvas (or WebGL) renderer.
  `culling.ts`, `rows.ts` and hit testing are already independent of the
  DOM (hits are resolved against the render blocks, not against SVG nodes),
  so a Canvas lane renderer would replace only `LaneRow.tsx`.
- The cost is dominated by React reconciliation and SVG layout of the
  element list, not by the culling itself, which stays under a millisecond
  per lane.
