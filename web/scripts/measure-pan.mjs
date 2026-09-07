// Measures how long a pan takes to render at several zoom levels, in
// headless Chrome, against the production build in dist/.
//
//   npm run build
//   node scripts/synthetic-trace.mjs --events 100000 --threads 8 > /tmp/synthetic.rvtrace
//   node scripts/measure-pan.mjs /tmp/synthetic.rvtrace
//
// Needs Chrome (CHROME env var, default /usr/bin/google-chrome) and
// puppeteer-core. Each pan dispatches a shift+wheel event on the lanes and
// waits for two animation frames; the floor is therefore two frames
// (about 33 ms at 60 Hz), which means "rendered within one frame".

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const tracePath = resolve(process.argv[2] ?? "/tmp/synthetic.rvtrace");
const dist = resolve("dist");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".rvtrace": "application/x-ndjson" };

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const file = url.pathname === "/trace.rvtrace" ? tracePath : join(dist, url.pathname === "/" ? "index.html" : url.pathname);
  try {
    statSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  headless: "new",
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const loadStarted = Date.now();
await page.goto(`http://127.0.0.1:${port}/?trace=/trace.rvtrace`, { waitUntil: "networkidle0" });
await page.waitForSelector('svg[aria-label="Thread lanes"]', { timeout: 120_000 });
const loadMs = Date.now() - loadStarted;

const WINDOWS = [null, 2_000_000_000, 800_000_000, 200_000_000, 70_000_000, 20_000_000];
const rows = [];
for (const windowNs of WINDOWS) {
  const result = await page.evaluate(async (ns) => {
    const svg = document.querySelector('svg[aria-label="Thread lanes"]');
    const body = svg.parentElement;
    const rect = svg.getBoundingClientRect();
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const wheel = (opts) => body.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: rect.left + rect.width * 0.6, clientY: rect.top + 40, ...opts }));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
    await frames();
    if (ns !== null) {
      // ctrl+wheel around the pointer until the visible window is about `ns`
      for (let i = 0; i < 200 && Number(svg.dataset.visibleNs) > ns; i++) {
        wheel({ ctrlKey: true, deltaY: -60 });
        await frames();
      }
    }
    const times = [];
    for (let i = 0; i < 6; i++) {
      const started = performance.now();
      wheel({ shiftKey: true, deltaY: 120 });
      await frames();
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    return {
      visibleMs: Number(svg.dataset.visibleNs) / 1e6,
      rects: svg.querySelectorAll("rect").length,
      lines: svg.querySelectorAll("line").length,
      median: times[Math.floor(times.length / 2)],
      max: times[times.length - 1],
    };
  }, windowNs);
  rows.push({ window: windowNs === null ? `whole trace (${result.visibleMs.toFixed(0)} ms)` : `${result.visibleMs.toFixed(0)} ms`, ...result });
}

await browser.close();
server.close();

console.log(`load (fetch + parse + model): ${loadMs} ms`);
console.log("| Visible window | rect / line elements | pan median / max |");
console.log("|---|---|---|");
for (const r of rows) console.log(`| ${r.window} | ${r.rects} / ${r.lines} | ${r.median.toFixed(0)} ms / ${r.max.toFixed(0)} ms |`);
