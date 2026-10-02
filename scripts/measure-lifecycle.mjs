/**
 * Measure the real cost of page parking: memory held per open page, and the
 * wall-clock cost of reopening one. Grounds the lifecycle design in numbers.
 *
 *   HOME=<workspace>/.dev/home node scripts/measure-lifecycle.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { RemoteClient, waitForJson } from '../src/remote.js';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig, resolveUserDataDir } from '../src/config.js';

const config = resolveConfig({ fps: 12 });
const profileDir = resolveUserDataDir(config);
const browser = new AgentBrowser({ config, log: () => {} });

/** Total RSS of chrome processes belonging to our profile. */
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
      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      const match = /VmRSS:\s+(\d+) kB/.exec(status);
      if (match) rssKb += Number(match[1]);
    } catch {
      // Process exited mid-scan.
    }
  }
  return { rssMb: Math.round(rssKb / 1024), processes: count };
}

await browser.ensureStarted();
await browser.navigate('https://example.com/');
const version = await waitForJson(`http://127.0.0.1:${browser.status().port}/json/version`);
const cdp = await RemoteClient.connect(version.webSocketDebuggerUrl);
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

await settle(2000);
const one = footprint();
console.log(`1 page open : ${one.rssMb} MB / ${one.processes} procs`);

// Two more pages, each fully rendered.
const created = [];
for (const url of ['https://www.iana.org/help/example-domains', 'https://example.org/']) {
  const target = await cdp.send('Target.createTarget', { url });
  created.push(target.targetId);
}
await settle(3000);
const three = footprint();
console.log(`3 pages open: ${three.rssMb} MB / ${three.processes} procs  (+${three.rssMb - one.rssMb} MB, +${three.processes - one.processes} procs)`);

// Park them: close the targets, keep the browser.
for (const targetId of created) await cdp.send('Target.closeTarget', { targetId });
await settle(2500);
const parked = footprint();
console.log(`2 parked    : ${parked.rssMb} MB / ${parked.processes} procs  (${parked.rssMb - three.rssMb} MB freed)`);

// Reopen cost: create + navigate + first paint.
const t0 = Date.now();
const reopened = await cdp.send('Target.createTarget', { url: 'https://example.com/' });
const attached = await cdp.send('Target.attachToTarget', { targetId: reopened.targetId, flatten: true });
await cdp.send('Page.enable', {}, attached.sessionId);
const navigated = Date.now();
let firstFrameAt = 0;
const off = cdp.on('Page.loadEventFired', () => {
  if (!firstFrameAt) firstFrameAt = Date.now();
}, attached.sessionId);
for (let i = 0; i < 60 && !firstFrameAt; i += 1) await settle(100);
off();
console.log(`reopen      : createTarget ${navigated - t0} ms, load event ${firstFrameAt ? firstFrameAt - t0 : 'timeout'} ms`);
await cdp.send('Target.closeTarget', { targetId: reopened.targetId });
cdp.close();
await browser.dispose();
const after = footprint();
console.log(`after stop  : ${after.rssMb} MB / ${after.processes} procs`);
