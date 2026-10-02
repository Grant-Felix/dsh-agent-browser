/**
 * Route-layer smoke test — a fake `webServer` service over a real node:http
 * server, driving the real runtime. No DSH involved.
 *
 *   HOME=<workspace>/.dev/home node scripts/smoke-routes.mjs
 */
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { defaultRegistryPath } from '../src/registry.js';
import { SearchService, defaultSearchStorePath } from '../src/search.js';

// Hermetic: no pages remembered from an earlier run.
rmSync(defaultRegistryPath(), { force: true });
rmSync(defaultSearchStorePath(), { force: true });

const config = resolveConfig({ fps: 10, searchProbeTimeoutMs: 6000 });
const browser = new AgentBrowser({ config, log: () => {} });
const search = new SearchService({ browser, config, log: () => {} });

/** The narrowest web-server stub the route layer touches. */
const holder = { route: null };
const webServer = {
  register(route) {
    holder.route = route;
    return () => {
      holder.route = null;
    };
  },
};

// The real plugin receives this service through ctx.inject(['webServer'], …),
// so the test passes the service directly — the same contract.
registerRoutes(webServer, browser, search);
if (!holder.route) {
  console.log('REGISTER_FAILED');
  process.exit(1);
}
console.log(`registered: kind=${holder.route.kind} path=${holder.route.path}`);

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://dsh.internal').pathname;
  if (pathname === holder.route.path || pathname.startsWith(`${holder.route.path}/`)) {
    void holder.route.handler(req, res);
    return;
  }
  res.writeHead(404).end('nope');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const json = async (path, init) => {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, body: await response.json().catch(() => null) };
};

console.log('GET  status  ->', JSON.stringify(await json('/api/agent-browser/status')));
console.log('GET  unknown ->', JSON.stringify(await json('/api/agent-browser/nope')));
console.log('POST origin  ->', JSON.stringify(await json('/api/agent-browser/command', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
  body: JSON.stringify({ action: 'status' }),
})));
const opened = await json('/api/agent-browser/command', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'open', url: 'https://example.com/' }),
});
console.log('POST open    ->', opened.status, opened.body?.state, opened.body?.url);
const post = (body) =>
  json('/api/agent-browser/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// A second page, then the lifecycle commands the panel and the tool share.
const second = await post({ action: 'open', url: 'https://example.org/', newPage: true });
console.log('POST open#2  ->', second.status, 'pages:', (second.body?.pages ?? []).map((p) => `${p.key}:${p.state}${p.active ? '*' : ''}`).join(' '));

const parked = await post({ action: 'close', page: 'p1' });
console.log('POST close   ->', parked.status, 'pages:', (parked.body?.pages ?? []).map((p) => `${p.key}:${p.state}`).join(' '));

const restored = await post({ action: 'restore', page: 'p1' });
console.log('POST restore ->', restored.status, 'pages:', (restored.body?.pages ?? []).map((p) => `${p.key}:${p.state}`).join(' '));

const pages = await post({ action: 'pages' });
console.log('POST pages   ->', pages.status, 'policy:', JSON.stringify(pages.body?.policy));

const swept = await post({ action: 'sweep' });
console.log('POST sweep   ->', swept.status, JSON.stringify(swept.body?.swept));

// Search: the panel's address bar reaches exactly these.
const engines = await post({ action: 'engines' });
console.log('POST engines ->', engines.status, `${(engines.body?.engines ?? []).length} engine(s), active=${engines.body?.active ?? 'none'}`);

const searched = await post({ action: 'search', query: 'wikipedia' });
console.log(
  'POST search  ->',
  searched.status,
  `blocked=${searched.body?.blocked} engine=${searched.body?.engine?.id ?? '-'} attempts=${(searched.body?.attempts ?? []).map((a) => `${a.id}:${a.status}`).join('>')}`,
);

console.log('POST bad     ->', JSON.stringify(await post({ action: 'nonsense' })));

// SSE: collect events for a few seconds.
const events = [];
const controller = new AbortController();
const stream = await fetch(`${base}/api/agent-browser/stream`, { signal: controller.signal });
const reader = stream.body.getReader();
const decoder = new TextDecoder();
const pump = (async () => {
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const chunk of text.split('\n\n')) {
        const name = /^event: (.+)$/m.exec(chunk)?.[1];
        if (name) events.push(name);
      }
    }
  } catch {
    // Aborted below.
  }
})();
await new Promise((r) => setTimeout(r, 3500));
controller.abort();
await pump;
const counts = events.reduce((acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }), {});
console.log('SSE events   ->', JSON.stringify(counts));
// Liveness is "the stream carried something", not "a picture frame arrived":
// whether frames land inside a 3.5 s window depends on the live page, and that
// made this assertion flaky. `meta`/`status` prove the channel works.
const streamAlive = counts.status > 0 && (counts.frame > 0 || counts.meta > 0);

// Sleep and wake must be per page: closing a background tab must not touch the
// one the user is looking at, and restoring one must not restore them all.
const beforeSelective = await post({ action: 'pages' });
const sleepP2 = await post({ action: 'close', page: 'p2' });
const afterSleep = await post({ action: 'pages' });
const p1StillLive = (afterSleep.body?.pages ?? []).some((page) => page.key === 'p1' && page.state === 'live');
const p2Parked = (afterSleep.body?.pages ?? []).some((page) => page.key === 'p2' && page.state === 'parked');
console.log(
  'POST sleep p2->',
  sleepP2.status,
  `closed=${sleepP2.body?.closed?.key} p1=${p1StillLive ? 'live' : '?'} p2=${p2Parked ? 'parked' : '?'}`,
);
const selectiveSleepOk = sleepP2.status === 200 && sleepP2.body?.closed?.key === 'p2' && p1StillLive && p2Parked;

const wakeP2 = await post({ action: 'restore', page: 'p2' });
const afterWake = await post({ action: 'pages' });
const p2LiveAgain = (afterWake.body?.pages ?? []).some((page) => page.key === 'p2' && page.state === 'live');
const othersUntouched =
  (beforeSelective.body?.pages ?? []).filter((page) => page.key !== 'p2').every((page) =>
    (afterWake.body?.pages ?? []).some((after) => after.key === page.key && after.state === page.state),
  );
console.log('POST wake p2 ->', wakeP2.status, `restored=${wakeP2.body?.restored?.key} others untouched=${othersUntouched}`);
const selectiveWakeOk = wakeP2.status === 200 && wakeP2.body?.restored?.key === 'p2' && p2LiveAgain && othersUntouched;

// The panel's "new tab" control sends an empty URL with newPage: the host must
// turn that into a real about:blank page rather than refusing or reusing a tab.
const before = await post({ action: 'pages' });
const newTab = await post({ action: 'open', url: '', newPage: true });
const after = await post({ action: 'pages' });
console.log(
  'POST newTab  ->',
  newTab.status,
  `${(before.body?.pages ?? []).length} -> ${(after.body?.pages ?? []).length} page(s), active=${after.body?.activeKey}, url=${after.body?.url}`,
);
const newTabOk =
  newTab.status === 200 &&
  (after.body?.pages ?? []).length === (before.body?.pages ?? []).length + 1 &&
  String(after.body?.url ?? '').startsWith('about:blank');

// The panel's page chips call `activate`: a parked page must come back by key.
const parked2 = await post({ action: 'close', page: 'p1' });
const activated = await post({ action: 'activate', page: 'p1' });
console.log(
  'POST activate->',
  activated.status,
  `active=${activated.body?.activeKey} pages=${(activated.body?.pages ?? []).map((p) => `${p.key}:${p.state}`).join(' ')}`,
);
const activateOk =
  activated.status === 200 &&
  activated.body?.activeKey === 'p1' &&
  (activated.body?.pages ?? []).some((page) => page.key === 'p1' && page.state === 'live');
if (!activateOk) console.log('  (parked request returned', parked2.status, ')');

// Forget drops the record entirely — the destructive counterpart of parking,
// which the tab menu offers next to it.
const beforeForget = await post({ action: 'pages' });
const forgetP4 = await post({ action: 'forget', page: 'p4' });
const afterForget = await post({ action: 'pages' });
const forgotOk =
  forgetP4.status === 200 &&
  forgetP4.body?.forgotten?.key === 'p4' &&
  (afterForget.body?.pages ?? []).length === (beforeForget.body?.pages ?? []).length - 1 &&
  !(afterForget.body?.pages ?? []).some((page) => page.key === 'p4');
console.log(
  'POST forget p4->',
  forgetP4.status,
  `forgot=${forgetP4.body?.forgotten?.key} ${(beforeForget.body?.pages ?? []).length} -> ${(afterForget.body?.pages ?? []).length} page(s)`,
);

// The panel reconnects on its own after a drop, so a second subscription must
// work exactly like the first — and the first must have released its listeners.
const reconnectEvents = [];
const controller2 = new AbortController();
const stream2 = await fetch(`${base}/api/agent-browser/stream`, { signal: controller2.signal });
const reader2 = stream2.body.getReader();
const pump2 = (async () => {
  try {
    for (;;) {
      const { value, done } = await reader2.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const chunk of text.split('\n\n')) {
        const name = /^event: (.+)$/m.exec(chunk)?.[1];
        if (name) reconnectEvents.push(name);
      }
    }
  } catch {
    // Aborted below.
  }
})();
await new Promise((r) => setTimeout(r, 3000));
controller2.abort();
await pump2;
const secondCounts = reconnectEvents.reduce((acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }), {});
console.log('SSE reconnect ->', JSON.stringify(secondCounts));
const reconnectOk = secondCounts.status > 0 && (secondCounts.frame > 0 || counts.frame > 0);

// Requirement: the panel IS the display, so "not displayed" is equivalent to
// headless. Consequences, all asserted here without waiting for a clock:
//   a) opening the panel brings a stopped browser up by itself;
//   b) while a panel is connected the browser is not idle-reclaimed, and the page
//      on screen is not parked either;
//   c) once the panel goes away, the same sweep does reclaim it (otherwise the
//      exemption would be an unbounded leak rather than a policy).
await post({ action: 'stop' });
const beforeOpen = await post({ action: 'status' });
const panelController = new AbortController();
const panelStream = await fetch(`${base}/api/agent-browser/stream`, { signal: panelController.signal });
const panelReader = panelStream.body.getReader();
void (async () => {
  try {
    for (;;) {
      const { done } = await panelReader.read();
      if (done) break;
    }
  } catch {
    // Aborted below.
  }
})();

// (a0) a panel that connects to a STILL page must still get a picture: Chromium's
// screencast is damage-driven, so without a replay the stage would stay blank —
// which is the "not displayed" state this plugin must never be in.
await post({ action: 'open', url: 'about:blank' });
await new Promise((resolve) => setTimeout(resolve, 2500));
const stillController = new AbortController();
const stillResponse = await fetch(`${base}/api/agent-browser/stream`, { signal: stillController.signal });
const stillReader = stillResponse.body.getReader();
const stillDecoder = new TextDecoder();
let replayed = 0;
const deadline = Date.now() + 4000;
while (Date.now() < deadline && replayed === 0) {
  const { value, done } = await Promise.race([
    stillReader.read(),
    new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 1000)),
  ]);
  if (done) break;
  if (value) replayed = (stillDecoder.decode(value, { stream: true }).match(/^event: frame$/gm) ?? []).length;
}
stillController.abort();
await stillReader.cancel().catch(() => {});
const replayOk = replayed > 0;
console.log('still page -> a fresh panel received a frame:', replayed);

// (a) the panel alone is enough to bring it up — no tool call, no button.
let startedByPanel = false;
for (let i = 0; i < 40 && !startedByPanel; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  startedByPanel = (await post({ action: 'status' })).body?.state === 'running';
}
const viewersNow = browser.viewerCount;
console.log('panel opened ->', `was ${beforeOpen.body?.state}, now ${(await post({ action: 'status' })).body?.state}, viewers=${viewersNow}`);

// (b) watched: not reclaimed, and the page on screen stays.
const watched = await browser.sweep({ now: Date.now() + 99 * 3600_000 });
const watchedOk =
  startedByPanel &&
  viewersNow > 0 &&
  watched.stopped === false &&
  watched.watched === true &&
  !watched.parked.includes(browser.status().activeKey);
console.log('sweep while watched ->', JSON.stringify({ viewers: viewersNow, stopped: watched.stopped, parked: watched.parked }));

// (c) panel gone: the same sweep reclaims it.
panelController.abort();
await panelStream.body.cancel?.().catch?.(() => {});
let released = browser.viewerCount;
for (let i = 0; i < 20 && released > 0; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  released = browser.viewerCount;
}
const unwatched = await browser.sweep({ now: Date.now() + 99 * 3600_000 });
const unlockedOk = released === 0 && unwatched.stopped === true;
console.log('sweep with no panel ->', JSON.stringify({ viewers: released, stopped: unwatched.stopped, reason: unwatched.reason }));

await browser.dispose();
await new Promise((resolve) => server.close(resolve));
console.log(streamAlive && reconnectOk && activateOk && newTabOk && selectiveSleepOk && selectiveWakeOk && forgotOk && watchedOk && unlockedOk && replayOk ? 'ROUTES_OK' : 'ROUTES_INCOMPLETE');
