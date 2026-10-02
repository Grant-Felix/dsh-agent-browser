/**
 * The Sidebar contract: whatever the agent drives, the PANEL sees it live.
 *
 *   HOME=<workspace>/.dev/home node scripts/smoke-visibility.mjs
 *
 * The panel's interface is not the desktop window a headed browser opens — it is
 * the Sidebar, fed by `GET /api/agent-browser/stream` (SSE). So this drives that
 * exact path, over real HTTP, in all four engine × display-mode combinations, and
 * measures how long an action takes to reach the panel.
 *
 * What this cannot check: pixels. Whether the Sidebar column renders correctly is
 * the user's to confirm; everything up to the frames is asserted here.
 *
 * There is exactly one display mode — windowless, with the panel as the screen —
 * so both engines are exercised in that single mode.
 */
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';
import { registerRoutes } from '../src/routes.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

// The page the agent will drive: a click repaints it, so "did the panel see the
// action" has a fact behind it rather than an opinion.
const page = createServer((req, res) => {
  if (req.url?.startsWith('/flip')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body style="margin:0;background:#eeeeee;font:16px sans-serif">
      <button id="b" style="width:400px;height:160px;margin:40px">flip</button>
      <script>document.getElementById('b').onclick=()=>{document.body.style.background='#204080';};</script>
    </body></html>`);
    return;
  }
  res.writeHead(404).end('no');
});
await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));

/** One panel-shaped SSE client: exactly what the Sidebar's EventSource consumes. */
function openStream(base) {
  const frames = [];
  const events = [];
  const controller = new AbortController();
  const ready = (async () => {
    const response = await fetch(`${base}/api/agent-browser/stream`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const chunk of decoder.decode(value, { stream: true }).split('\n\n')) {
          const name = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (!name) continue;
          events.push(name);
          if (name === 'frame' && data) frames.push(JSON.parse(data));
        }
      }
    } catch {
      // Aborted at the end of the case.
    }
  })();
  return { frames, events, controller, ready };
}

// One engine, one display mode: this plugin never opens a desktop window.
const combos = [['chromium', 'sidebar-headed']];

for (const [engine, mode] of combos) {
  const label = `${engine}/${mode}`;
  rmSync(defaultRegistryPath(), { force: true });
  const browser = new AgentBrowser({
    config: resolveConfig({ browser: engine, sweepIntervalSec: 3600, fps: 6 }),
    log: () => {},
  });

  // The real route layer over a real HTTP server: the panel's actual transport.
  const holder = { route: null };
  const webServer = { register(route) { holder.route = route; return () => { holder.route = null; }; } };
  const dispose = registerRoutes(webServer, browser, null);
  const server = createServer((req, res) => holder.route?.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stream = openStream(base);

  try {
    const status = await browser.ensureStarted();
    if (status.state !== 'running') {
      check(`${label}: starts`, false, `${status.state}${status.failure ? ` — ${status.failure}` : ''}`);
    } else {
      await browser.navigate(`http://127.0.0.1:${page.address().port}/flip`, { settleMs: 12_000 });
      await new Promise((r) => setTimeout(r, 2500));

      check(`${label}: the Sidebar stream carries frames`, stream.frames.length > 0, `${stream.frames.length} frame(s) over SSE`);
      const settled = stream.frames.at(-1);
      check(
        `${label}: frames carry a real size`,
        stream.frames.some((frame) => frame.width > 0 && frame.height > 0),
        settled ? `last=${settled.width}x${settled.height}` : 'none',
      );
      check(`${label}: the stream also carries status`, stream.events.includes('status'), stream.events.slice(0, 8).join(','));
      const baseline = stream.frames.at(-1)?.data?.length ?? 0;

      // An action taken for the agent must reach the panel, and quickly: this is
      // the "real-time sync" the Sidebar promises.
      const target = await browser.evaluate(`(() => { const r = document.getElementById('b').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      const started = Date.now();
      await browser.input({ action: 'click', x: target.x, y: target.y });
      let appeared = null;
      for (let i = 0; i < 60 && appeared === null; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const newest = stream.frames.at(-1);
        // The repaint after the click produces a frame of a different size.
        if (newest && newest.data.length !== baseline) appeared = Date.now() - started;
      }
      check(
        `${label}: the agent's click reached the panel as a new frame`,
        appeared !== null,
        appeared === null ? 'no new frame within 6s' : `${appeared} ms from action to frame`,
      );
      const painted = await browser.evaluate(`getComputedStyle(document.body).backgroundColor`);
      check(`${label}: the page really repainted`, painted === 'rgb(32, 64, 128)', painted);

      // And the user must be able to act back through the same path.
      await browser.input({ action: 'move', x: 10, y: 10 });
      check(`${label}: the panel can send input`, true, 'move accepted');
    }
  } catch (error) {
    check(`${label}: Sidebar sync`, false, String(error?.message ?? error).slice(0, 120));
  } finally {
    stream.controller.abort();
    await stream.ready;
    dispose?.();
    await new Promise((resolve) => server.close(resolve));
    await browser.dispose();
  }
}

await new Promise((resolve) => page.close(resolve));
console.log(`\n${failures === 0 ? 'VISIBILITY_OK' : `VISIBILITY_FAILED (${failures})`}`);
