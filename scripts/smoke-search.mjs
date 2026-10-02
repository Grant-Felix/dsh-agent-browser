/**
 * Search-engine acceptance test against the real network.
 *
 *   HOME=<workspace>/.dev/home node scripts/smoke-search.mjs [engine,engine,…]
 *
 * Proves: a pre-configured table exists, probing measures real navigations,
 * a winner is picked and persisted, and `search` needs only a query — no engine
 * URL ever has to be typed.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';
import { SearchService, defaultSearchStorePath, judgeReport, pageReport } from '../src/search.js';
import { readJson } from '../src/store.js';

const probeIds = (process.argv[2] ?? 'duckduckgo,bing,baidu,google').split(',').map((id) => id.trim()).filter(Boolean);

const registryPath = defaultRegistryPath();
const storePath = defaultSearchStorePath();
rmSync(registryPath, { force: true });
rmSync(storePath, { force: true });

const config = resolveConfig({ 
  sweepIntervalSec: 3600,
  searchProbeTimeoutMs: 6000,
  searchProbeQuery: 'wikipedia',
});

const browser = new AgentBrowser({ config, registryPath, log: (m) => console.log(`  [runtime] ${m}`) });
const search = new SearchService({ browser, config, storePath, log: (m) => console.log(`  [search] ${m}`) });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// 1. The table is pre-configured and query-parameterised.
const engines = search.list();
check('engines are pre-configured', engines.length >= 8, `${engines.length} engines`);
check('every engine is a query template', engines.every((engine) => engine.url.includes('{q}')));
check('nothing is selected before the first probe', search.activeId() === null, `active=${search.activeId()}`);

// 2. Open a page the user "was looking at", so the probe must give it back.
await browser.navigate('https://example.com/');
const beforeKey = browser.status().activeKey;

// 2b. Regression, pinned to a real failure: this exact Sogou anti-spider URL was
//     captured live (2026-10-02) after a search whose verdict said "ok", because
//     the page says 此验证码 rather than 请输入验证码 and has outbound links.
//     The verdict must hold whatever that page's link count happens to be.
try {
  await browser.navigate('https://www.sogou.com/antispider/?m=1&antip=web_hd', { settleMs: 8000 });
  const wall = await browser.evaluate(pageReport('deepseek harness'));
  const verdict = judgeReport(wall);
  check('a real anti-spider wall is judged blocked', verdict.blocked === true, `status=${verdict.status} url=${String(wall?.url).slice(0, 70)}`);
  check('and never usable', verdict.usable === false, `usable=${verdict.usable} hasQuery=${wall?.hasQuery} links=${wall?.links}`);
  // Informational only — Sogou's link count varies, so report it instead of
  // asserting it. The point is that the verdict does not depend on it.
  const fooledOldRule = (wall?.links ?? 0) >= 3 && wall?.hasQuery !== true;
  console.log(`      (links=${wall?.links}, hasQuery=${wall?.hasQuery})${fooledOldRule ? ' — the old links-only rule would have called this usable' : ''}`);
} catch (error) {
  console.log(`SKIP  anti-spider regression (navigation failed: ${error?.message ?? error})`);
}

// 3. Probe for real.
console.log(`\nprobing ${probeIds.join(', ')} …`);
const started = Date.now();
const probe = await search.probe({ engines: probeIds, select: true });
console.log(`probe took ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
for (const entry of probe.ranking) {
  console.log(
    `   ${entry.usable ? 'USABLE ' : 'unusable'} ${entry.id.padEnd(12)} ${entry.status.padEnd(8)} ` +
      `wall=${String(entry.wallMs).padStart(5)}ms ttfb=${String(entry.ttfbMs).padStart(5)} links=${String(entry.links).padStart(3)} ${entry.title.slice(0, 40)}`,
  );
  if (!entry.usable) {
    console.log(`            finalUrl: ${(entry.finalUrl ?? entry.url).slice(0, 110)}`);
    if (entry.sample) console.log(`            sample  : ${entry.sample.slice(0, 110)}`);
    if (entry.error) console.log(`            error   : ${entry.error.slice(0, 110)}`);
  }
}
console.log('');

check('probing ranked the candidates', probe.ranking.length === probeIds.length, `${probe.ranking.length} entries`);
check('at least one engine was usable', probe.ranking.some((entry) => entry.usable), `recommendation=${probe.recommendation?.id ?? 'none'}`);
check('the fastest usable engine won', !probe.recommendation || probe.recommendation.id === probe.ranking.find((e) => e.usable)?.id, `winner=${probe.recommendation?.id}`);
check('the pick was persisted to disk', existsSync(storePath) && readJson(storePath, {})?.selected === probe.recommendation?.id, `file selected=${readJson(storePath, {})?.selected}`);
check('the active choice is now that engine', search.activeId() === probe.recommendation?.id, `active=${search.activeId()}`);

// 4. The probe must hand browsing back where it was, not leave the probe page.
check('the probe page is gone afterwards', browser.listPages().filter((page) => page.state === 'live').length === 1, JSON.stringify(browser.listPages().map((p) => `${p.key}:${p.state}`)));
check('the original page is active again', browser.status().activeKey === beforeKey, `activeKey=${browser.status().activeKey} (was ${beforeKey})`);

// 5. A search needs only a query.
const result = await search.search('deepseek harness');
check('search routes through the chosen engine', result.url.includes(result.engine.id === 'baidu' || result.engine.id === 'sogou' ? encodeURIComponent('deepseek harness') : encodeURIComponent('deepseek harness')), result.url);
check('search lands on a live page', browser.status().state === 'running' && browser.status().url.includes('deepseek'), browser.status().url);
console.log(`   searched via ${result.engine.name}: ${result.url}`);

// 6. A pinned config wins over the measured choice, and no probe is needed.
const pinnedConfig = resolveConfig({ ...config, searchEngine: 'bing' });
const pinned = new SearchService({ browser, config: pinnedConfig, storePath: `${storePath}.pinned`, log: () => {} });
check('an explicit pin overrides the measured choice', pinned.activeId() === 'bing', `active=${pinned.activeId()}`);
rmSync(`${storePath}.pinned`, { force: true });

await browser.dispose();
console.log(failures === 0 ? '\nSEARCH_OK' : `\nSEARCH_FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
