/**
 * Second measurement pass: does closing a page target actually reclaim memory,
 * given enough time? And what does a real reopen (enable Page, then navigate)
 * cost?
 *
 *   HOME=<workspace>/.dev/home node scripts/measure-lifecycle2.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { RemoteClient, waitForJson } from '../src/remote.js';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig, resolveUserDataDir } from '../src/config.js';

const config = resolveConfig({ fps: 12 });
const profileDir = resolveUserDataDir(config);
const browser = new AgentBrowser({ config, log: () => {} });
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

function footprint() {
  let rssKb = 0;
  let count = 0;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline = '';
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!cmdline.includes(profileDir)) continue;
    count += 1;
    try {
      const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${entry}/status`, 'utf8'));
      if (match) rssKb += Number(match[1]);
    } catch {
      // Exited mid-scan.
    }
  }
  return `${Math.round(rssKb / 1024)} MB / ${count} procs`;
}

await browser.ensureStarted();
await browser.navigate('https://example.com/');
const version = await waitForJson(`http://127.0.0.1:${browser.status().port}/json/version`);
const cdp = await RemoteClient.connect(version.webSocketDebuggerUrl);
await settle(2000);
console.log('baseline (1 page)      :', footprint());

const created = [];
for (const url of ['https://www.iana.org/help/example-domains', 'https://example.org/', 'https://example.net/']) {
  const target = await cdp.send('Target.createTarget', { url });
  created.push(target.targetId);
}
await settle(4000);
console.log('4 pages open           :', footprint());

for (const targetId of created) await cdp.send('Target.closeTarget', { targetId });
for (const wait of [2000, 8000, 20000]) {
  await settle(wait);
  const list = await cdp.send('Target.getTargets');
  const pages = list.targetInfos.filter((t) => t.type === 'page').length;
  console.log(`+${String(wait / 1000).padStart(2)}s after parking     : ${footprint()}  (page targets: ${pages})`);
}

// Real reopen timing: attach + Page.enable BEFORE navigating.
const t0 = Date.now();
const created2 = await cdp.send('Target.createTarget', { url: 'about:blank' });
const attached = await cdp.send('Target.attachToTarget', { targetId: created2.targetId, flatten: true });
await cdp.send('Page.enable', {}, attached.sessionId);
await cdp.send('Runtime.enable', {}, attached.sessionId);
const ready = Date.now();
const loaded = new Promise((resolve) => {
  const off = cdp.on('Page.loadEventFired', () => {
    off();
    resolve(Date.now());
  }, attached.sessionId);
  setTimeout(() => {
    off();
    resolve(0);
  }, 20000);
});
await cdp.send('Page.navigate', { url: 'https://example.com/' }, attached.sessionId);
const loadedAt = await loaded;
console.log(`reopen: createTarget+attach+enable ${ready - t0} ms, navigate→load ${loadedAt ? loadedAt - ready : 'timeout'} ms`);
await cdp.send('Target.closeTarget', { targetId: created2.targetId });
cdp.close();
await browser.dispose();
await settle(500);
console.log('after browser stop     :', footprint());
