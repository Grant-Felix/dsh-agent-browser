/**
 * Can the OS itself drive the browser's pointer?
 *
 *   HOME=<workspace>/.dev/home node scripts/probe-os-input.mjs
 *
 * xdotool speaks XTEST, so a move/click it sends is indistinguishable from real
 * hardware at the X level — no CDP Input domain, no synthetic DOM event. This
 * probes whether that route is usable for this browser window before anything
 * is built on it.
 *
 * It calibrates the screen offset FROM THE PAGE (`window.screenX/screenY` plus
 * the window chrome difference), because guessing a decoration size is exactly
 * the kind of hardcoded assumption this project avoids.
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';

const which = (name) => {
  try {
    return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

const xdotool = which('xdotool');
console.log(`xdotool: ${xdotool ?? 'NOT INSTALLED'}`);
if (!xdotool) process.exit(0);

rmSync(defaultRegistryPath(), { force: true });
const browser = new AgentBrowser({
  config: resolveConfig({ sweepIntervalSec: 3600, humanizeInput: false }),
  log: () => {},
});

await browser.ensureStarted();
await browser.navigate('about:blank');
await browser.evaluate(`(() => {
  document.body.style.margin = '0';
  document.body.innerHTML = '<div id="box" style="width:100%;height:100vh;background:#eee"></div>';
  window.__moves = [];
  window.__clicks = [];
  document.addEventListener('mousemove', (e) => window.__moves.push([Math.round(e.clientX), Math.round(e.clientY)]), true);
  document.addEventListener('click', (e) => window.__clicks.push([e.clientX, e.clientY]), true);
  return true;
})()`);

// Give the window manager a moment to map the window.
await new Promise((r) => setTimeout(r, 2500));

const status = browser.status();
const geometry = await browser.evaluate(`(() => ({
  screenX: window.screenX,
  screenY: window.screenY,
  outerW: window.outerWidth,
  outerH: window.outerHeight,
  innerW: window.innerWidth,
  innerH: window.innerHeight,
}))()`);
const px = Math.round(geometry.innerW * 0.4);
const py = Math.round(geometry.innerH * 0.45);
const screenX = Math.round(geometry.screenX + (geometry.outerW - geometry.innerW) / 2 + px);
const screenY = Math.round(geometry.screenY + (geometry.outerH - geometry.innerH) + py);

console.log(`browser pid=${status.pid}   page inner=${geometry.innerW}x${geometry.innerH}   X offset=${screenX - px},${screenY - py}`);

// A pid search misses the window: Chrome's window belongs to a child process,
// and under native Wayland it is not an X window at all. Match on geometry
// instead — the page reports its own outer size, so the window that agrees with
// it is the browser's, with nothing hardcoded.
let windows = [];
try {
  windows = execFileSync(xdotool, ['search', '--onlyvisible', '--name', '.'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
} catch {
  windows = [];
}
const candidates = [];
for (const id of windows) {
  try {
    const info = execFileSync(xdotool, ['getwindowgeometry', '--shell', id], { encoding: 'utf8' });
    const width = Number(/WINDOW_WIDTH=(\d+)/.exec(info)?.[1]);
    const height = Number(/WINDOW_HEIGHT=(\d+)/.exec(info)?.[1]);
    if (Number.isFinite(width) && Number.isFinite(height)) candidates.push({ id, width, height });
  } catch {
    // Window disappeared or is not queryable; skip it.
  }
}
const match = candidates
  .map((c) => ({ ...c, delta: Math.abs(c.width - geometry.outerW) + Math.abs(c.height - geometry.outerH) }))
  .sort((a, b) => a.delta - b.delta)[0];
console.log(`xdotool sees ${candidates.length} window(s); best size match to the browser (${geometry.outerW}x${geometry.outerH}): ${match ? `${match.id} (${match.width}x${match.height}, delta=${match.delta})` : 'none'}`);

const before = await browser.evaluate('window.__moves.length');
try {
  execFileSync(xdotool, ['mousemove', String(screenX), String(screenY)], { encoding: 'utf8' });
} catch (error) {
  console.log(`xdotool mousemove failed: ${error?.message ?? error}`);
}
await new Promise((r) => setTimeout(r, 800));
const afterMove = await browser.evaluate('window.__moves.length');
console.log(`pointer moved to screen (${screenX},${screenY}) -> page saw ${afterMove - before} new mousemove event(s)`);

try {
  execFileSync(xdotool, ['click', '1'], { encoding: 'utf8' });
} catch (error) {
  console.log(`xdotool click failed: ${error?.message ?? error}`);
}
await new Promise((r) => setTimeout(r, 800));
const clicks = await browser.evaluate('window.__clicks');
console.log(`xdotool click -> page saw ${clicks.length} click(s): ${JSON.stringify(clicks.slice(0, 3))}`);

const verdict = afterMove > before && clicks.length > 0 ? 'USABLE' : afterMove > before ? 'move-only' : 'NOT USABLE';
console.log(`\nOS-level input via xdotool: ${verdict}\n`);
await browser.dispose();
