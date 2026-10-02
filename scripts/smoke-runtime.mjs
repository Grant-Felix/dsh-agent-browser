/**
 * Standalone runtime smoke test — no DSH involved.
 *
 *   HOME=<workspace>/.dev/home node scripts/smoke-runtime.mjs [url]
 *
 * HOME is redirected so every write (profile, pid/port lock) stays inside the
 * workspace, which is what a file sandbox permits.
 */
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig, describeResolution } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';

// Hermetic: no pages remembered from an earlier run.
rmSync(defaultRegistryPath(), { force: true });

const url = process.argv[2] ?? 'https://example.com/';
const config = resolveConfig({ fps: 12, jpegQuality: 55 });
const log = (...args) => console.log('[runtime]', ...args);

console.log('resolution:', JSON.stringify(describeResolution(config), null, 2));

const browser = new AgentBrowser({ config, log });
const frames = [];
const metas = [];
browser.onFrame((frame) => frames.push(frame));
browser.onMeta((meta) => metas.push(meta));

const started = await browser.ensureStarted();
console.log('ensureStarted ->', started.state, started.failure ?? '');
if (started.state !== 'running') {
  await browser.dispose();
  process.exit(1);
}

await browser.navigate(url);
await new Promise((r) => setTimeout(r, 2500));

const digest = await browser.read();
console.log('read ->', JSON.stringify({ url: digest.url, title: digest.title, text: digest.text?.slice(0, 120), interactive: digest.interactive?.length }, null, 2));

await browser.input({ action: 'scroll', nx: 0.5, ny: 0.5, deltaY: 400 });
await browser.input({ action: 'move', nx: 0.3, ny: 0.4 });

const shot = await browser.screenshot();
console.log('screenshot ->', shot.data?.length ?? 0, 'base64 chars');

await new Promise((r) => setTimeout(r, 1200));
console.log('frames ->', frames.length, frames[0] ? `${frames[0].width}x${frames[0].height}, ${frames[0].data.length} b64` : '(none)');
console.log('metas ->', JSON.stringify(metas.slice(-3)));
console.log('status ->', JSON.stringify(browser.status(), null, 2));

await browser.dispose();
console.log('disposed ->', browser.status().state);
console.log(frames.length > 0 ? 'SMOKE_OK' : 'SMOKE_NO_FRAMES');
