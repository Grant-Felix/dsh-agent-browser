/**
 * Lifecycle acceptance test: park-on-demand, idle sweeps, disk memory, and
 * restore-on-cold-start — all without waiting hours (the sweep takes an
 * injected clock).
 *
 *   HOME=<workspace>/.dev/home node scripts/smoke-lifecycle.mjs
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig, resolveDisplayMode } from '../src/config.js';
import { defaultRegistryPath, readRegistry } from '../src/registry.js';

const registryPath = defaultRegistryPath();
rmSync(registryPath, { force: true });

const config = resolveConfig({
  
  pageIdleTimeoutMin: 180,
  browserIdleTimeoutMin: 360,
  restoreOnDemand: true,
  maxLivePages: 8,
  sweepIntervalSec: 3600,
});
const browser = new AgentBrowser({ config, registryPath, log: () => {} });

let failures = 0;
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`${mark}  ${label}${detail ? `  — ${detail}` : ''}`);
}

const pageOf = (key) => browser.listPages().find((page) => page.key === key);

// 0. No screen size is assumed anywhere. With a default config the viewport is
//    AUTO: nothing is overridden, and the page's own layout is what a pointer
//    ratio resolves against.
//    A separate profile dir on purpose: Chromium refuses a second instance on a
//    profile that is already in use, and this browser runs beside the main one.
const autoConfig = resolveConfig({
  
  sweepIntervalSec: 3600,
  userDataDir: join(process.env.HOME ?? '', '.local', 'share', 'dsh-agent-browser', 'profile-auto'),
});
rmSync(`${registryPath}.auto`, { force: true });
const autoBrowser = new AgentBrowser({ config: autoConfig, registryPath: `${registryPath}.auto`, log: () => {} });
const autoStatus = autoBrowser.status();
check(
  'default viewport is AUTO (no assumed screen size)',
  autoStatus.viewport.width === 0 && autoStatus.viewport.height === 0 && autoStatus.viewport.source === 'auto',
  JSON.stringify(autoStatus.viewport),
);
await autoBrowser.navigate('https://example.com/');
const autoAfter = autoBrowser.status();
check(
  // With no panel attached the windowless browser still needs a screen, or the
  // page renders at 0x0 (frames 0, clicks nowhere). AUTO now means "the panel owns
  // the screen; until it reports one, use the virtual screen".
  'AUTO falls back to the virtual screen and the page renders at it',
  autoAfter.viewport.source === 'auto' &&
    autoAfter.screen?.source === 'virtual' &&
    autoAfter.screen.width === autoConfig.virtualScreenWidth &&
    autoAfter.screen.height === autoConfig.virtualScreenHeight &&
    autoAfter.pageViewport?.width === autoConfig.virtualScreenWidth,
  JSON.stringify({ viewport: autoAfter.viewport, screen: autoAfter.screen, pageViewport: autoAfter.pageViewport }),
);
await autoBrowser.dispose();
rmSync(`${registryPath}.auto`, { force: true });

// 1. Two pages, the second one active.
await browser.navigate('https://example.com/');
await browser.navigate('https://example.org/', { newPage: true });
const pagesAfterOpen = browser.listPages();
check('two live pages after open', pagesAfterOpen.length === 2 && pagesAfterOpen.every((p) => p.state === 'live'), JSON.stringify(pagesAfterOpen.map((p) => `${p.key}:${p.state}${p.active ? '*' : ''}`)));
check('second page is active and focused', pageOf('p2')?.active === true && browser.status().url === 'https://example.org/', browser.status().url);
// Regression: a fresh target emits frameNavigated(about:blank) before the real
// URL commits, and open used to return that stale blank document. The bounded
// settle means the summary carries the loaded page.
check('newPage returns the loaded page, not about:blank', browser.status().url === 'https://example.org/' && (pageOf('p2')?.title ?? '') !== '', `url=${browser.status().url} title="${pageOf('p2')?.title}"`);

// 1b. The panel drives the viewport, so the picture fills its column instead of
//     a landscape page being scaled into a portrait one.
const resized = await browser.setViewport({ width: 420, height: 900 });
check('setViewport applies the requested size', resized.changed === true && resized.viewport.width === 420 && resized.viewport.height === 900, JSON.stringify(resized.viewport));
const frameForSize = await new Promise((resolve) => {
  const off = browser.onFrame((frame) => {
    if (frame.width === 420 && frame.height === 900) {
      off();
      resolve(frame);
    }
  });
  setTimeout(() => {
    off();
    resolve(null);
  }, 6000);
});
check('the relayed stream follows the new viewport', frameForSize !== null, frameForSize ? `${frameForSize.width}x${frameForSize.height}` : 'no 420x900 frame within 6s');
// Regression: a resize fires no load event, so the page's self-reported size
// used to stay at its pre-drag value while viewport/frame moved on.
const pageAfterResize = browser.status().pageViewport;
check(
  'the page self-reports the new size after a resize',
  pageAfterResize?.width === 420 && pageAfterResize?.height === 900,
  JSON.stringify(pageAfterResize),
);
const clamped = await browser.setViewport({ width: 100, height: 100 });
check(
  'setViewport clamps to the configured rails',
  clamped.viewport.width === config.viewportMinWidth && clamped.viewport.height === config.viewportMinHeight,
  `${JSON.stringify(clamped.viewport)} vs rails ${config.viewportMinWidth}x${config.viewportMinHeight}`,
);

// 1c. A Sidebar drag is a burst of sizes; the newest must win without queuing
//     one apply per event (each apply is a CDP round trip per page).
const burst = await Promise.all([
  browser.setViewport({ width: 500, height: 800 }),
  browser.setViewport({ width: 520, height: 810 }),
  browser.setViewport({ width: 540, height: 820 }),
]);
check('a resize burst coalesces instead of queuing', burst.filter((r) => r.coalesced === true).length >= 2, `coalesced ${burst.filter((r) => r.coalesced).length}/3`);
const newest = browser.status().viewport;
check('the newest size wins', newest.width === 540 && newest.height === 820, JSON.stringify(newest));
const frameForNewest = await new Promise((resolve) => {
  const off = browser.onFrame((frame) => {
    if (frame.width === 540) {
      off();
      resolve(frame);
    }
  });
  setTimeout(() => {
    off();
    resolve(null);
  }, 6000);
});
check('the stream settles on the newest size', frameForNewest !== null, frameForNewest ? `${frameForNewest.width}x${frameForNewest.height}` : 'no 540-wide frame');
await browser.setViewport({ width: 900, height: 1600 });

// 1d. A human-verification wall must be REPORTED, never treated as content:
//     no control channel can prove humanity, so the panel hands it to the user.
try {
  await browser.navigate('https://www.sogou.com/antispider/?m=1&antip=web_hd', { settleMs: 10_000 });
  const wall = browser.status().humanCheck;
  check('a verification wall is surfaced to the user', wall?.detected === true, JSON.stringify(wall));
  await browser.navigate('https://example.com/');
  check('and it clears on an ordinary page', browser.status().humanCheck === null, JSON.stringify(browser.status().humanCheck));
} catch (error) {
  console.log(`SKIP  human-check regression (navigation failed: ${error?.message ?? error})`);
}

// Policy: exactly one display mode — headed, with the Sidebar panel as its head.
// There is no headless mode and no desktop-window mode.
const mode = resolveDisplayMode();
check('the mode is the sidebar-headed one', mode.mode === 'sidebar-headed' && mode.headed === true, JSON.stringify(mode));
check('and no desktop window is ever opened', mode.desktopWindow === false && /Sidebar/.test(mode.reason), mode.reason);

// 2. "Done with this page": park the one we are not looking at.
const closed = await browser.closePage('p1');
check('close p1 parks it', pageOf('p1')?.state === 'parked', `reason=${closed.reason}`);
check('close keeps the URL for later', pageOf('p1')?.url === 'https://example.com/', pageOf('p1')?.url);
check('p2 is untouched by parking p1', pageOf('p2')?.state === 'live');
// Regression: closePage must name the page it parked, not the active one
// (the tool report named the wrong key when a non-active page was closed).
check('close reports the page it actually parked', closed.closed?.key === 'p1' && closed.closed?.url === 'https://example.com/', JSON.stringify(closed.closed));

// 3. Bring it back on demand.
const restored = await browser.restorePage('p1');
check('restore p1 makes it live again', pageOf('p1')?.state === 'live', `reason=${restored.reason}`);
check('restore reports the page it restored', restored.restored?.key === 'p1', JSON.stringify(restored.restored));
check('restored page really loaded its URL', (await browser.read('p1')).url === 'https://example.com/', 'read(p1) returned example.com');

// 4. Idle sweep parks pages past pageIdleTimeoutMin but keeps the browser.
const pageSweep = await browser.sweep({ now: Date.now() + 181 * 60_000 });
check('181 min sweep parks every page', pageSweep.parked.length === 2 && browser.listPages().every((p) => p.state === 'parked'), `parked=${pageSweep.parked.join(',')}`);
check('browser still running at 181 min', browser.state === 'running' && pageSweep.stopped === false);

// 5. Past browserIdleTimeoutMin the whole browser goes away.
const browserSweep = await browser.sweep({ now: Date.now() + 361 * 60_000 });
check('361 min sweep stops the browser', browserSweep.stopped === true && browser.state === 'stopped', `reason=${browserSweep.reason}`);

// 6. The registry on disk remembers the pages across the stop.
const stored = readRegistry(registryPath);
check('registry file exists on disk', existsSync(registryPath), registryPath);
check('registry remembers both URLs', stored.pages.length === 2, JSON.stringify(stored.pages.map((p) => p.url)));
check('registry records which page was active', typeof stored.activeKey === 'string' && stored.activeKey !== '', stored.activeKey);

// 7. A cold start brings the remembered active page back without being asked.
// Restoring p1 in step 3 made it the active page, so p1 is what should return.
const before = Date.now();
await browser.ensureStarted();
const startedIn = Date.now() - before;
const activeUrl = browser.listPages().find((page) => page.active)?.url;
check('cold start restores the remembered active page', browser.state === 'running' && activeUrl === 'https://example.com/', `active=${activeUrl}`);
check('restore is fast (~ms, plus page load)', startedIn < 20_000, `${startedIn} ms for the whole cold start`);
check('exactly one page is live after restore', browser.listPages().filter((p) => p.state === 'live').length === 1, JSON.stringify(browser.listPages().map((p) => `${p.key}:${p.state}`)));

// 8. The live cap parks the least recently used page.
const capped = resolveConfig({ ...config, maxLivePages: 1, pageIdleTimeoutMin: 0 });
const cappedBrowser = new AgentBrowser({ config: capped, registryPath: `${registryPath}.cap`, log: () => {} });
await cappedBrowser.navigate('https://example.com/');
await cappedBrowser.navigate('https://example.org/', { newPage: true });
await cappedBrowser.navigate('https://example.net/', { newPage: true });
const capSweep = await cappedBrowser.sweep();
check('live-page cap parks the oldest pages', cappedBrowser.listPages().filter((p) => p.state === 'live').length === 1 && capSweep.parked.length === 2, `parked=${capSweep.parked.join(',')}`);
await cappedBrowser.dispose();
rmSync(`${registryPath}.cap`, { force: true });

await browser.dispose();
console.log(failures === 0 ? '\nLIFECYCLE_OK' : `\nLIFECYCLE_FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
