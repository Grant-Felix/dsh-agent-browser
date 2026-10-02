/**
 * Is the pointer motion actually hand-like? Measure it instead of claiming it.
 *
 *   HOME=<workspace>/.dev/home node scripts/measure-pointer.mjs
 *
 * Records every mousemove the page receives during one drag, then reports the
 * statistics that distinguish a human hand from a script:
 * - path efficiency (path length / straight-line distance): 1.00 is a ruler line
 * - curvature: peak deviation from the straight chord
 * - speed profile: max/mean ratio, high when a hand accelerates and settles
 * - tremor: RMS deviation from the smoothed path
 * - reversals: how often the lateral offset changes direction
 * Runs the same motion with `pointerModel: 'linear'` for contrast.
 */
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';

const RECORDER = `(() => {
  window.__path = [];
  const start = performance.now();
  document.addEventListener('mousemove', (event) => {
    window.__path.push({ x: event.clientX, y: event.clientY, t: performance.now() - start, buttons: event.buttons });
  }, true);
  return true;
})()`;

/** Statistics that separate a hand from a script. */
function analyse(points) {
  const held = points.filter((p) => p.buttons === 1);
  const path = held.length >= 3 ? held : points;
  if (path.length < 3) return null;
  const first = path[0];
  const last = path[path.length - 1];
  const chord = Math.hypot(last.x - first.x, last.y - first.y) || 1;
  let length = 0;
  const speeds = [];
  for (let i = 1; i < path.length; i += 1) {
    const segment = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    const dt = Math.max(1, path[i].t - path[i - 1].t);
    length += segment;
    speeds.push((segment / dt) * 1000);
  }
  // Signed perpendicular offset from the chord, for curvature and reversals.
  const ux = (last.x - first.x) / chord;
  const uy = (last.y - first.y) / chord;
  const offsets = path.map((p) => (p.x - first.x) * -uy + (p.y - first.y) * ux);
  const peak = Math.max(...offsets.map(Math.abs));
  let reversals = 0;
  for (let i = 2; i < offsets.length; i += 1) {
    const a = offsets[i - 1] - offsets[i - 2];
    const b = offsets[i] - offsets[i - 1];
    if (a * b < 0) reversals += 1;
  }
  const meanSpeed = speeds.reduce((s, v) => s + v, 0) / speeds.length;
  const maxSpeed = Math.max(...speeds);
  // Tremor: RMS of the second difference (how jagged the samples are).
  let rms = 0;
  for (let i = 2; i < path.length; i += 1) {
    const ddx = path[i].x - 2 * path[i - 1].x + path[i - 2].x;
    const ddy = path[i].y - 2 * path[i - 1].y + path[i - 2].y;
    rms += ddx * ddx + ddy * ddy;
  }
  return {
    samples: path.length,
    durationMs: Math.round(last.t - first.t),
    efficiency: Number((length / chord).toFixed(3)),
    curvaturePx: Math.round(peak),
    maxOverMeanSpeed: Number((maxSpeed / (meanSpeed || 1)).toFixed(2)),
    tremorRmsPx: Number(Math.sqrt(rms / Math.max(1, path.length - 2)).toFixed(2)),
    reversals,
  };
}

const run = async (model, jitter) => {
  rmSync(defaultRegistryPath(), { force: true });
  const browser = new AgentBrowser({
    config: resolveConfig({ sweepIntervalSec: 3600, pointerModel: model, pointerJitter: jitter, pointerSpeedPxPerSec: 700 }),
    log: () => {},
  });
  await browser.navigate('about:blank');
  await browser.evaluate(
    `document.body.style.margin='0'; document.body.innerHTML='<div id="pad" style="width:100%;height:100vh"></div>'; ${RECORDER}`,
  );
  const size = await browser.evaluate('({ w: window.innerWidth, h: window.innerHeight })');
  const from = { x: Math.round(size.w * 0.15), y: Math.round(size.h * 0.3) };
  const to = { x: Math.round(size.w * 0.8), y: Math.round(size.h * 0.62) };
  await browser.input({ action: 'down', x: from.x, y: from.y });
  await browser.input({ action: 'drag', x: from.x, y: from.y, toX: to.x, toY: to.y });
  const stats = analyse(await browser.evaluate('window.__path'));
  await browser.dispose();
  return stats;
};

const linear = await run('linear', 0);
const human = await run('human', 1);
const shaky = await run('human', 3);

const pad = (v, w = 8) => String(v).padStart(w);
console.log('\n=== pointer motion, one drag of ~900 px ===');
console.log(`  ${'model'.padEnd(22)} ${pad('samples')} ${pad('ms')} ${pad('efficiency')} ${pad('curve px')} ${pad('max/mean')} ${pad('tremor')} ${pad('reversals')}`);
for (const [label, stats] of [['linear (teleport)', linear], ['human jitter=1', human], ['human jitter=3', shaky]]) {
  if (!stats) {
    console.log(`  ${label.padEnd(22)} (no path recorded)`);
    continue;
  }
  console.log(
    `  ${label.padEnd(22)} ${pad(stats.samples)} ${pad(stats.durationMs)} ${pad(stats.efficiency)} ${pad(stats.curvaturePx)} ${pad(stats.maxOverMeanSpeed)} ${pad(stats.tremorRmsPx)} ${pad(stats.reversals)}`,
  );
}
const verdict = human && linear && human.samples > linear.samples * 5 && human.curvaturePx > 5 && shaky.tremorRmsPx > human.tremorRmsPx;
console.log(`\n  hand-like motion is real and jitter is controllable: ${verdict ? 'YES' : 'NO'}\n`);
