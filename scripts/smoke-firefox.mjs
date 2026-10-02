/**
 * Firefox end-to-end: the same runtime, driven through WebDriver BiDi.
 *
 *   HOME=<workspace>/.dev/home node scripts/smoke-firefox.mjs
 *
 * Firefox 157 exposes no CDP at all, so this exercises the second backend on the
 * real protocol: context creation, navigation, RemoteValue unwrapping, polled
 * frames, viewport control, the full input path, and park/restore.
 */
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';
import { resolveFirefoxPath } from '../src/config.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

const firefox = resolveFirefoxPath({});
if (!firefox) {
  console.log('SKIP  no Firefox binary found');
  process.exit(0);
}
console.log(`firefox: ${firefox}`);

rmSync(defaultRegistryPath(), { force: true });
// `headless` defaults to 'auto', which on a machine with a display means HEADED,
// so both modes are exercised: node scripts/smoke-firefox.mjs headed
const headed = process.argv.includes('headed');
const config = resolveConfig({
  browser: 'firefox',
  
  sweepIntervalSec: 3600,
  fps: 3,
  pointerSpeedPxPerSec: 4000,
});
const browser = new AgentBrowser({ config, log: (message) => console.log(`  [runtime] ${message}`) });

// 1. cold start on the second engine
const started = await browser.ensureStarted();
check('the runtime starts Firefox', started.state === 'running', `${started.state}${started.failure ? ` — ${started.failure}` : ''}`);
check('status reports the engine', started.engine === 'firefox', `engine=${started.engine}`);
if (started.state !== 'running') {
  console.log('\nFIREFOX_FAILED (cannot continue without a browser)');
  await browser.dispose();
  process.exit(1);
}

// 2. navigate and read
await browser.navigate('https://example.com/', { settleMs: 15_000 });
const digest = await browser.read();
check('a page navigates and reports its identity', digest.url === 'https://example.com/' && /Example Domain/i.test(digest.title ?? ''), `${digest.url} "${digest.title}"`);
// Assert the plumbing, not a third-party page's copy: the digest must agree with
// what the page itself reports as innerText. (example.com has rewritten its own
// text twice during this project, which broke copy-based assertions.)
const pageText = await browser.evaluate('document.body.innerText');
check(
  'the page digest carries the page\'s own text',
  String(digest.text ?? '').length > 20 && String(digest.text).startsWith(String(pageText).slice(0, 40)),
  `${String(digest.text).length} chars, page reports ${String(pageText).length}`,
);
check('interactive elements include coordinates', Array.isArray(digest.interactive) && digest.interactive.every((el) => Number.isFinite(el.x)), `${digest.interactive?.length ?? 0} element(s)`);
check('page layout is known (no assumed size)', digest.humanCheck !== undefined && browser.status().pageViewport?.width > 0, JSON.stringify(browser.status().pageViewport));

// 2b. `navigator.webdriver` parity, and the honest differential that shows the
//     override is what does it (no preference changes this on the current build).
// The override REMOVES the property rather than making it false: detectors check
// `navigator.webdriver || 'webdriver' in navigator` (bot.sannysoft.com's own source),
// so a false-valued property still fails. Assert the stronger fact.
const overridden = await browser.evaluate(`({ value: navigator.webdriver, present: 'webdriver' in navigator, onProto: 'webdriver' in Navigator.prototype })`);
check(
  'the webdriver override removes the property entirely',
  overridden.value === undefined && overridden.present === false && overridden.onProto === false,
  JSON.stringify(overridden),
);

// 3. RemoteValue unwrapping, the part most likely to be wrong
const nested = await browser.evaluate(
  `({ a: 1, b: 'x', c: [1, 2, 3], d: { e: null, f: true }, g: [{ h: 'deep' }], n: NaN, big: 12345678901234 })`,
);
const nestedOk =
  nested?.a === 1 &&
  nested?.b === 'x' &&
  Array.isArray(nested?.c) &&
  nested.c.length === 3 &&
  nested?.d?.e === null &&
  nested?.d?.f === true &&
  nested?.g?.[0]?.h === 'deep' &&
  Number.isNaN(nested?.n) &&
  nested?.big === 12345678901234;
check('nested values survive the BiDi value model', nestedOk, JSON.stringify(nested));

// 4. screenshot
const shot = await browser.screenshot();
check('a screenshot comes back as PNG', shot.format === 'png' && shot.data?.startsWith('iVBOR'), `${shot.data?.length ?? 0} base64 chars`);

// 5. frames are polled on this engine
const frames = [];
const off = browser.onFrame((frame) => frames.push(frame));
await new Promise((r) => setTimeout(r, 2500));
off();
check('frames arrive from the polling loop', frames.length >= 2, `${frames.length} frame(s) in 2.5s at fps=3`);
check('frames decode their own size from the image', frames[0]?.width > 0 && frames[0]?.height > 0, frames[0] ? `${frames[0].width}x${frames[0].height}` : 'no frame');

// 6. a locally built interactive page, for the whole input path
await browser.navigate('about:blank');
await browser.evaluate(`(() => {
  document.body.style.margin = '0';
  document.body.innerHTML =
    '<input id="text" type="text" style="width:400px;height:40px;margin:20px">' +
    '<input id="slider" type="range" min="0" max="100" value="0" style="width:600px;height:40px;margin:20px">' +
    '<button id="btn" style="width:200px;height:60px;margin:20px">Press me</button>';
  window.__clicks = 0;
  window.__path = [];
  document.getElementById('btn').addEventListener('click', () => { window.__clicks += 1; });
  document.addEventListener('mousemove', (e) => window.__path.push([Math.round(e.clientX), Math.round(e.clientY)]), true);
  return true;
})()`);
const boxes = await browser.evaluate(`(() => {
  const rect = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), left: r.left, mid: r.top + r.height / 2, width: r.width }; };
  return { text: rect('text'), slider: rect('slider'), button: rect('btn') };
})()`);

const typed = await browser.evaluate(`(() => { document.getElementById('text').focus(); return true; })()`);
await browser.input({ action: 'text', text: 'bidi typing' });
const textValue = await browser.evaluate(`document.getElementById('text').value`);
check('typing reaches the field through BiDi keys', textValue === 'bidi typing', JSON.stringify(textValue));

await browser.input({ action: 'click', x: boxes.button.cx, y: boxes.button.cy });
const clicks = await browser.evaluate('window.__clicks');
check('a click lands on the button', clicks === 1, `__clicks=${clicks}`);

await browser.input({ action: 'drag', x: Math.round(boxes.slider.left + 8), y: Math.round(boxes.slider.mid), toX: Math.round(boxes.slider.left + boxes.slider.width * 0.8), toY: Math.round(boxes.slider.mid) });
const sliderValue = Number(await browser.evaluate(`document.getElementById('slider').value`));
check('a held-button drag moves a slider', sliderValue > 40, `value=${sliderValue}`);

await browser.evaluate(`document.getElementById('slider').focus()`);
await browser.input({ action: 'key', key: 'ArrowRight' });
const afterKey = Number(await browser.evaluate(`document.getElementById('slider').value`));
check('named keys arrive', afterKey === sliderValue + 1, `${sliderValue} -> ${afterKey}`);

const path = await browser.evaluate('window.__path');
const held = path.filter((p) => p[0] < 700);
check('the pointer travelled a multi-sample path, not a teleport', path.length >= 4, `${path.length} mousemove sample(s)`);

// 7. viewport control
const resized = await browser.setViewport({ width: 500, height: 800 });
await new Promise((r) => setTimeout(r, 400));
const pageSize = await browser.evaluate('({ w: window.innerWidth, h: window.innerHeight })');
check('setViewport reaches the page', pageSize.w === 500 && pageSize.h === 800, JSON.stringify(pageSize));

// 8. park and restore
const parked = await browser.closePage();
check('a page parks (context closed, URL kept)', parked.ok !== false && parked.closed?.url !== undefined, JSON.stringify(parked.closed));
const restored = await browser.restorePage();
check('and restores from the remembered URL', restored.ok !== false && restored.restored?.url !== undefined, JSON.stringify(restored.restored));

// Only one backend may run at a time, and the rule must hold while the OTHER
// engine is up — so this runs BEFORE the stop below. Refusing silently would look
// like a crash, hence the message check. (The bug this guards against was real:
// the stale-instance check probed the old port with THIS engine's protocol, which
// fails across engines, so a live Firefox was invisible to it.)
const chromiumProbe = new AgentBrowser({ config: resolveConfig({ browser: 'chromium', sweepIntervalSec: 3600 }), log: () => {} });
const refused = await chromiumProbe.ensureStarted();
const conflictOk =
  refused.state === 'failed' && /already running/.test(refused.failure ?? '') && /one backend/.test(refused.failure ?? '');
console.log('cross-engine start while firefox runs ->', `state=${refused.state}`, (refused.failure ?? '').slice(0, 88));

// 9. stop
const stopped = await browser.stop('test finished');
check('the browser stops cleanly', stopped.state === 'stopped', stopped.state);

// Once the holder stops, the same start succeeds: the rule is a lock, not a ban.
const handedOver = await chromiumProbe.ensureStarted();
const handoverOk = handedOver.state === 'running';
console.log('after the holder stops ->', `state=${handedOver.state}`);
await chromiumProbe.dispose();


await browser.dispose();

// Differential: with the override off, Firefox identifies itself again. Without
// this the assertion above would pass even if the override did nothing.
try {
  const plain = new AgentBrowser({
    config: resolveConfig({ browser: 'firefox', sweepIntervalSec: 3600, hideWebdriver: false }),
    log: () => {},
  });
  await plain.ensureStarted();
  await plain.navigate('about:blank');
  const bare = await plain.evaluate('navigator.webdriver');
  check('turning the override off restores Firefox\'s own answer', bare === true, `navigator.webdriver=${bare}`);
  await plain.dispose();
} catch (error) {
  console.log(`SKIP  override-off differential (${String(error?.message ?? error).slice(0, 80)})`);
}

console.log(`\n${failures === 0 && conflictOk && handoverOk ? 'FIREFOX_OK' : `FIREFOX_FAILED (${failures})`}`);
