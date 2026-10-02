/**
 * Measure how modern anti-bot systems actually treat this browser.
 *
 *   HOME=<workspace>/.dev/home node scripts/measure-challenge.mjs
 *
 * Reports, per system, the thing that decides access:
 * - reCAPTCHA v3  → the numeric confidence score (0.0-1.0)
 * - Cloudflare Turnstile → whether the interactive widget appears / resolves
 * - nowsecure.nl (Cloudflare bot detection) → whether the challenge page yields
 * - hCaptcha → whether a checkbox challenge is presented
 * - bot.sannysoft.com → classic row failures, kept for continuity
 *
 * A single number that "passes" is worth more than any argument about which
 * protocol is stealthier, so this is the instrument for that decision.
 */
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';

const mode = process.argv[2] ?? 'headed';
rmSync(defaultRegistryPath(), { force: true });

const config = resolveConfig({ sweepIntervalSec: 3600 });
const browser = new AgentBrowser({ config, log: () => {} });
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

const report = (system, verdict, detail = '') => {
  results.push({ system, verdict, detail });
  console.log(`  ${String(verdict).padEnd(10)} ${system.padEnd(24)} ${detail}`);
};

await browser.ensureStarted();
console.log(`\n=== challenge landscape: ${mode} (UA: ${(await (async () => {
  await browser.navigate('about:blank');
  return browser.evaluate('navigator.userAgent');
})()).slice(-60)}) ===\n`);

// 1. reCAPTCHA v3 — the only system here that hands out a number.
try {
  await browser.navigate('https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php', { settleMs: 15000 });
  await settle(5000);
  const score = await browser.evaluate(
    `(() => { const m = (document.body.innerText || '').match(/0\\.\\d+/); return m ? Number(m[0]) : null; })()`,
  );
  report('reCAPTCHA v3', score === null ? 'no-score' : score >= 0.7 ? 'PASS' : score >= 0.5 ? 'marginal' : 'FAIL', `score=${score}`);
} catch (error) {
  report('reCAPTCHA v3', 'unreachable', String(error?.message).slice(0, 60));
}

// 2. Cloudflare Turnstile demo — does the widget resolve by itself?
try {
  await browser.navigate('https://demo.turnstile.workers.dev/', { settleMs: 15000 });
  await settle(6000);
  const state = await browser.evaluate(`(() => {
    const widget = document.querySelector('.cf-turnstile, [data-sitekey]');
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
    const response = document.querySelector('input[name="cf-turnstile-response"]');
    return {
      widget: !!widget,
      solved: !!(response && response.value && response.value.length > 20),
      success: /success|signed in|welcome/i.test(text),
      snippet: text.slice(0, 120),
    };
  })()`);
  report('Cloudflare Turnstile', state.solved || state.success ? 'PASS' : state.widget ? 'challenge' : 'no-widget', JSON.stringify(state).slice(0, 120));
} catch (error) {
  report('Cloudflare Turnstile', 'unreachable', String(error?.message).slice(0, 60));
}

// 3. nowsecure.nl — Cloudflare's bot-detection benchmark page.
try {
  await browser.navigate('https://nowsecure.nl/', { settleMs: 20000 });
  const started = Date.now();
  let passed = false;
  for (let i = 0; i < 20 && !passed; i += 1) {
    await settle(1000);
    passed = await browser.evaluate(`(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return t.includes('you are human') || t.includes('success') || (!document.querySelector('#challenge-running') && t.includes('nowsecure'));
    })()`);
  }
  report('Cloudflare (nowsecure)', passed ? 'PASS' : 'challenged', `${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (error) {
  report('Cloudflare (nowsecure)', 'unreachable', String(error?.message).slice(0, 60));
}

// 4. hCaptcha demo — is an interactive checkbox challenge presented?
try {
  await browser.navigate('https://accounts.hcaptcha.com/demo', { settleMs: 15000 });
  await settle(4000);
  const state = await browser.evaluate(`(() => {
    const frame = document.querySelector('iframe[src*="hcaptcha"]');
    const checkbox = document.querySelector('#checkbox, .check');
    return { frame: !!frame, checkbox: !!checkbox, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 90) };
  })()`);
  report('hCaptcha', state.checkbox ? 'challenge' : 'widget-only', JSON.stringify(state).slice(0, 110));
} catch (error) {
  report('hCaptcha', 'unreachable', String(error?.message).slice(0, 60));
}

// 5. Classic detector, for continuity with earlier runs.
try {
  await browser.navigate('https://bot.sannysoft.com/', { settleMs: 15000 });
  await settle(3000);
  const failed = await browser.evaluate(`(() => {
    let n = 0;
    for (const tr of document.querySelectorAll('table tr')) {
      const cells = [...tr.querySelectorAll('td,th')];
      if (cells.length < 2) continue;
      const bg = getComputedStyle(cells[1]).backgroundColor;
      const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(bg);
      if (m && +m[1] > 180 && +m[2] < 160 && +m[3] < 160) n += 1;
    }
    return n;
  })()`);
  report('sannysoft (classic)', failed === 0 ? 'PASS' : 'flagged', `${failed} failed row(s)`);
} catch (error) {
  report('sannysoft (classic)', 'unreachable', String(error?.message).slice(0, 60));
}

console.log(`\n=== ${mode}: ${results.filter((r) => r.verdict === 'PASS').length}/${results.length} passed ===\n`);
await browser.dispose();
