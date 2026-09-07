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

Measured with `scripts/measure-pan.mjs` against the production build:
headless Chrome, 1600×1000, a shift+wheel pan dispatched on the lanes and
timed until the next two animation frames. The floor is two 60 Hz frames,
so "33 ms" means the render fitted in a single frame. The traces come from
`scripts/synthetic-trace.mjs`, which writes threads taking turns on one
lock with random 20–170 µs slices; they are synthetic and say nothing
about Ruby, only about the renderer.

```sh
npm run build
node scripts/synthetic-trace.mjs --events 100000 --threads 8 > /tmp/synthetic.rvtrace
node scripts/measure-pan.mjs /tmp/synthetic.rvtrace
```

Synthetic trace, 100,000 events, 8 threads, 3.2 s (load: 0.86 s):

| Visible window | `rect` / `line` elements in the lanes | Pan (median / max) |
|---|---|---|
| whole trace (3183 ms), everything merged | 59 / 19 | 33 ms / 34 ms |
| 1747 ms | 58 / 18 | 33 ms / 34 ms |
| 710 ms | 1,770 / 18 | 33 ms / 34 ms |
| 184 ms, segments around 1 px | 3,891 / 18 | 34 ms / 55 ms |
| 64 ms | 2,963 / 18 | 33 ms / 34 ms |
| 19 ms | 1,116 / 18 | 33 ms / 33 ms |

Synthetic trace, 300,000 events, 16 threads, 9.6 s (load: 1.9 s):

| Visible window | `rect` / `line` elements | Pan (median / max) |
|---|---|---|
| whole trace (9564 ms) | 91 / 27 | 33 ms / 34 ms |
| 1837 ms | 155 / 26 | 33 ms / 34 ms |
| 747 ms, 16 lanes of ~1 px segments | 15,565 / 26 | 123 ms / 124 ms |
| 194 ms | 4,093 / 26 | 33 ms / 37 ms |
| 68 ms | 3,164 / 26 | 33 ms / 35 ms |
| 18 ms | 1,018 / 26 | 33 ms / 34 ms |

What this says about the SVG approach:

- Up to about 4,000 elements in the lanes a pan renders within one frame.
  Merging bounds the element count by lane width, not by segment count, so
  a trace of a few threads stays there at every zoom level: the worst
  window is the one where segments are about one pixel wide and cannot be
  merged yet.
- The bad case is many lanes at that pixel-wide zoom: 16 lanes produced
  15,565 rects and a pan cost 123 ms. That is the point where the lanes
  should move to a Canvas (or WebGL) renderer. `culling.ts`, `rows.ts` and
  hit testing are already independent of the DOM (hits are resolved against
  the render blocks, not against SVG nodes), so a Canvas lane renderer would
  replace only `LaneRow.tsx`.
- The cost is React reconciliation and SVG layout of the element list, not
  the culling itself, which stays under a millisecond per lane.
