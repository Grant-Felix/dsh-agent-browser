/**
 * Record every viewport change the host reports, so "drag the Sidebar and it
 * follows" becomes a timestamped trace instead of an impression.
 *
 *   node scripts/watch-viewport.mjs [seconds] [intervalMs]
 *
 * Prints one line per change (and a heartbeat every ~5 s). Ctrl+C is safe.
 */
const seconds = Number(process.argv[2] ?? 120);
const intervalMs = Number(process.argv[3] ?? 250);
const base = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
const url = `${base}/api/agent-browser/status`;

const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;
const size = (value) => (value ? `${value.width}x${value.height}` : '-');

function describe(status) {
  const vp = status.viewport ?? {};
  return [
    `viewport=${vp.source ?? '?'} ${size(vp)}`,
    `page=${size(status.pageViewport)}`,
    `frame=${size(status.frameViewport)}`,
    `state=${status.state}`,
  ].join(' | ');
}

let last = null;
let changes = 0;
let beats = 0;

console.log(`watching ${url} for ${seconds}s (every ${intervalMs}ms) — drag the Sidebar now`);
while (Date.now() - started < seconds * 1000) {
  let status;
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    status = await response.json();
  } catch (error) {
    console.log(`${at()}  (host unreachable: ${error?.message ?? error})`);
    await new Promise((r) => setTimeout(r, intervalMs));
    continue;
  }
  const line = describe(status);
  if (line !== last) {
    const first = last === null;
    last = line;
    if (!first) changes += 1;
    console.log(`${at()}  ${first ? 'initial ' : 'CHANGED '}${line}`);
    beats = 0;
  } else if (++beats % 20 === 0) {
    console.log(`${at()}  (unchanged) ${line}`);
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}

console.log(`\n${changes} change(s) observed in ${seconds}s`);
process.exit(0);
