/**
 * Protocol recon for the vendored Firefox: which remote protocol does this
 * build actually expose, and which of the operations this project needs are
 * available on it?
 *
 *   HOME=<workspace>/.dev/home node scripts/probe-firefox-protocol.mjs
 *
 * Prints facts only — the answers decide the Firefox backend design.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteClient } from '../src/remote.js';

const FIREFOX = join(process.cwd(), 'vendor', 'firefox', 'firefox', 'firefox');
const PROFILE = join(process.cwd(), '.dev', 'ff-probe-profile');
const PORT = 9333;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const child = spawn(
  FIREFOX,
  ['--headless', '--no-remote', `--profile`, PROFILE, `--remote-debugging-port`, String(PORT), 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
const stderrTail = [];
child.stderr.on('data', (d) => {
  stderrTail.push(String(d));
  if (stderrTail.length > 10) stderrTail.shift();
});
child.unref();

const probe = async (path) => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(2500) });
    const text = (await res.text()).slice(0, 160).replace(/\s+/g, ' ');
    return `HTTP ${res.status} ${text}`;
  } catch (error) {
    return `ERR ${error?.cause?.code ?? error?.name}: ${String(error?.message).slice(0, 60)}`;
  }
};

// Wait for the port to answer anything at all.
let up = false;
for (let i = 0; i < 40 && !up; i += 1) {
  await settle(500);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/status`, { signal: AbortSignal.timeout(1500) });
    up = res.status < 500;
  } catch {
    // Not listening yet.
  }
}
console.log(`firefox listening: ${up}`);
if (!up) {
  console.log('stderr tail:', stderrTail.join('').slice(-500));
  process.exit(1);
}

console.log('GET /status        ->', await probe('/status'));
console.log('GET /json/version  ->', await probe('/json/version'));
console.log('GET /json/list     ->', await probe('/json/list'));
console.log('GET /session       ->', await probe('/session'));

// WebDriver BiDi lives at ws://host:port/session on modern Firefox.
console.log('\n--- BiDi over ws://…/session ---');
let client;
try {
  client = await RemoteClient.connect(`ws://127.0.0.1:${PORT}/session`, { timeoutMs: 5000 });
  console.log('ws connected: yes');
} catch (error) {
  console.log('ws connected: NO —', error.message);
  console.log('stderr tail:', stderrTail.join('').slice(-400));
  process.exit(1);
}

const call = async (method, params = {}) => {
  try {
    const result = await client.send(method, params, undefined, 8000);
    return { ok: true, summary: JSON.stringify(result).slice(0, 200) };
  } catch (error) {
    return { ok: false, summary: `${error.message}`.slice(0, 160) };
  }
};

for (const [method, params] of [
  ['session.status', {}],
  ['session.new', { capabilities: {} }],
  ['browsingContext.getTree', {}],
  ['session.subscribe', { events: ['browsingContext.load'] }],
]) {
  const res = await call(method, params);
  console.log(`${res.ok ? 'OK  ' : 'FAIL'} ${method} -> ${res.summary}`);
}

const tree = await call('browsingContext.getTree', {});
console.log('tree ->', tree.summary);
let context = null;
try {
  const parsed = JSON.parse(tree.summary.replace(/\.\.\.$/, ''));
  context = parsed?.contexts?.[0]?.context ?? null;
} catch {
  // Fall through: create one below.
}

if (!context) {
  const created = await call('browsingContext.create', { type: 'tab' });
  console.log('create ->', created.summary);
  try {
    context = JSON.parse(created.summary)?.context ?? null;
  } catch {
    context = null;
  }
}
console.log('using context:', context);

if (context) {
  console.log('\n--- the operations this project needs ---');
  const checks = [
    ['browsingContext.navigate', { context, url: 'https://example.com/', wait: 'complete' }],
    ['script.evaluate', { expression: '({url: location.href, title: document.title})', target: { context }, awaitPromise: false, resultOwnership: 'none' }],
    ['browsingContext.captureScreenshot', { context, format: { type: 'image/jpeg', quality: 0.6 } }],
    ['input.performActions', { context, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: 100, y: 100, duration: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] }],
    ['browsingContext.setViewport', { context, viewport: { width: 900, height: 1400 }, devicePixelRatio: 1 }],
  ];
  for (const [method, params] of checks) {
    const res = await call(method, params);
    console.log(`${res.ok ? 'OK  ' : 'FAIL'} ${method} -> ${res.summary}`);
  }
}

client.close();
try {
  process.kill(-child.pid, 'SIGTERM');
} catch {
  child.kill('SIGTERM');
}
await settle(800);
console.log('\nprobe done');
