/**
 * How detectable is the automation environment?
 *
 *   HOME=<workspace>/.dev/home node scripts/measure-detectability.mjs
 *
 * Prints the signals anti-bot systems score, for whichever control channel the
 * runtime used, plus the verdict rows of a public detector page. Run it once per
 * control backend to compare them on facts instead of on claims.
 */
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';

const control = process.argv[2] ?? 'cdp';
const headed = process.argv.includes('headed');
rmSync(defaultRegistryPath(), { force: true });

const config = resolveConfig({ sweepIntervalSec: 3600 });
const browser = new AgentBrowser({ config, log: (m) => console.log(`  [runtime] ${m}`) });

/** The environment signals these systems actually look at. */
const FINGERPRINT = `(() => {
  const gl = (() => {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('webgl');
      const info = ctx && ctx.getExtension('WEBGL_debug_renderer_info');
      return ctx && info ? { vendor: ctx.getParameter(info.UNMASKED_VENDOR_WEBGL), renderer: ctx.getParameter(info.UNMASKED_RENDERER_WEBGL) } : null;
    } catch { return null; }
  })();
  return {
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    languages: navigator.languages,
    platform: navigator.platform,
    plugins: navigator.plugins.length,
    mimeTypes: navigator.mimeTypes.length,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    chromeObject: typeof window.chrome,
    chromeRuntime: !!(window.chrome && window.chrome.runtime),
    outerSize: window.outerWidth + 'x' + window.outerHeight,
    innerSize: window.innerWidth + 'x' + window.innerHeight,
    screenSize: screen.width + 'x' + screen.height,
    colorDepth: screen.colorDepth,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    webgl: gl,
  };
})()`;

/** Read the classic detector page as a list of label → verdict rows. */
const DETECTOR_ROWS = `(() => {
  const rows = [];
  for (const tr of document.querySelectorAll('table tr')) {
    const cells = [...tr.querySelectorAll('td,th')];
    if (cells.length < 2) continue;
    const test = (cells[0].innerText || '').trim().replace(/\\s+/g, ' ');
    if (!test) continue;
    const value = (cells[1].innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 44);
    // The page signals failure with a red/pink cell background, not with words,
    // so the colour is the verdict. Guessing from text flagged "missing (passed)".
    const bg = getComputedStyle(cells[1]).backgroundColor;
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(bg);
    const rgb = m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
    const red = rgb ? rgb.r > 180 && rgb.g < 160 && rgb.b < 160 : false;
    rows.push({ test: test.slice(0, 46), value, bg, failed: red });
  }
  return rows;
})()`;

await browser.ensureStarted();
await browser.navigate('about:blank');
const fp = await browser.evaluate(FINGERPRINT);
console.log(`\n=== control: ${control} — environment signals ===`);
for (const [key, value] of Object.entries(fp)) {
  const flag = key === 'webdriver' && value === true ? '   <-- AUTOMATION FLAG' : '';
  console.log(`  ${key.padEnd(20)} ${JSON.stringify(value)}${flag}`);
}

console.log('\n=== detector page (bot.sannysoft.com) ===');
try {
  await browser.navigate('https://bot.sannysoft.com/', { settleMs: 15000 });
  await new Promise((r) => setTimeout(r, 3000));
  const rows = await browser.evaluate(DETECTOR_ROWS);
  let failed = 0;
  for (const row of rows) {
    if (row.failed) failed += 1;
    if (row.failed) console.log(`  FAIL  ${row.test.padEnd(48)} ${row.value}   [${row.bg}]`);
  }
  console.log(`\n  rows: ${rows.length}, FAILED: ${failed}`);
} catch (error) {
  console.log(`  detector page unavailable: ${error?.message ?? error}`);
}

await browser.dispose();
