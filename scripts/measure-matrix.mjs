/**
 * The pass-rate matrix: every reachable system × engine × display mode.
 *
 *   HOME=<workspace>/.dev/home node scripts/measure-matrix.mjs
 *
 * Each system gets its OWN machine-readable verdict instead of a generic keyword
 * match, because "the page mentions captcha" is true of every demo page. For the
 * slider-style systems it also ATTEMPTS the challenge with a humanized drag and
 * reports whether it cleared — that is the number that actually matters.
 *
 * Results go to `.dev/matrix-<engine>-<mode>.json` for aggregation.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';

const engine = (process.argv[2] ?? 'chromium').toLowerCase();
// One display mode: headed, with the Sidebar panel as the head. There is no
// headed/headless axis to sweep any more.
const mode = 'sidebar-headed';


/** Each entry carries its own verdict expression, evaluated after settle. */
const ONLY = process.argv.slice(4);
const ALL_TARGETS = [
  {
    id: 'recaptcha-v3',
    url: 'https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php',
    kind: 'recaptcha',
    // Ask reCAPTCHA v3 directly for a token. The old verdict looked for a score
    // rendered by the demo's own server-side verification, which made the row
    // depend on that page's flow rather than on the browser (it read as
    // "no score" while it was in fact being handed a 2446-char token). A token is
    // the honest signal: v3 accepted the request without showing a challenge.
    verdict: `(async () => {
      try {
        const key = [...document.querySelectorAll('script')].map((s) => (s.src.match(/render=([\\w-]+)/) || [])[1]).find(Boolean);
        if (!key) return { state: 'unknown', detail: 'no sitekey on the page' };
        if (typeof grecaptcha === 'undefined') return { state: 'unknown', detail: 'grecaptcha did not load' };
        const token = await grecaptcha.execute(key, { action: 'homepage' });
        const len = String(token || '').length;
        return len > 100 ? { state: 'pass', detail: 'token ' + len + ' chars (no challenge)' } : { state: 'fail', detail: 'token ' + len + ' chars' };
      } catch (error) {
        return { state: 'fail', detail: 'execute failed: ' + String(error).slice(0, 40) };
      }
    })()`,
  },
  {
    id: 'recaptcha-v2',
    url: 'https://www.google.com/recaptcha/api2/demo',
    kind: 'recaptcha',
    verdict: `(() => { const t = document.querySelector('#g-recaptcha-response'); const n = t && t.value ? t.value.length : 0; return { state: n > 20 ? 'pass' : 'challenge', detail: n > 20 ? 'token ' + n + ' chars' : 'checkbox unsolved' }; })()`,
  },
  {
    id: 'hcaptcha',
    url: 'https://accounts.hcaptcha.com/demo',
    kind: 'hcaptcha',
    verdict: `(() => { const t = document.querySelector('[name="h-captcha-response"], #h-captcha-response'); const n = t && t.value ? t.value.length : 0; return { state: n > 20 ? 'pass' : 'challenge', detail: n > 20 ? 'token ' + n + ' chars' : 'widget unsolved' }; })()`,
  },
  {
    id: 'turnstile',
    url: 'https://demo.turnstile.workers.dev/',
    kind: 'turnstile',
    verdict: `(() => { const t = document.querySelector('[name="cf-turnstile-response"]'); const n = t && t.value ? t.value.length : 0; return { state: n > 20 ? 'pass' : 'challenge', detail: n > 20 ? 'token ' + n + ' chars' : 'widget unsolved' }; })()`,
  },
  {
    id: 'cloudflare-bot',
    url: 'https://nowsecure.nl/',
    kind: 'cloudflare',
    // Cloudflare keeps its challenge-platform scripts in the DOM after clearing,
    // so their presence says nothing. Only the VISIBLE interstitial does.
    verdict: `(() => { const text = (document.body.innerText || '').replace(/\s+/g, ' '); const busy = /verifying you are human|checking your browser|just a moment|enable javascript and cookies/i.test(text); const content = /nowsecure/i.test(text); return { state: busy ? 'challenge' : content ? 'pass' : 'unknown', detail: text.slice(0, 60) }; })()`,
  },
  {
    id: 'datadome',
    url: 'https://datadome.co/',
    kind: 'datadome',
    // Same trap: the interstitial frame can stay in the DOM once it is hidden.
    verdict: `(() => { const frames = [...document.querySelectorAll('iframe')].filter((f) => /captcha-delivery|captcha\\.datadome/i.test(f.src || '')); const visible = frames.some((f) => { const r = f.getBoundingClientRect(); return r.width > 80 && r.height > 60 && getComputedStyle(f).display !== 'none' && getComputedStyle(f).visibility !== 'hidden'; }); const text = (document.body.innerText || '').replace(/\\s+/g, ' '); return { state: visible ? 'challenge' : /datadome/i.test(text) ? 'pass' : 'unknown', detail: visible ? 'visible captcha-delivery iframe' : text.slice(0, 50) }; })()`,
  },
  {
    // Measured stable target: humansecurity.com is HUMAN-protected by its own
    // product and renders normally (window._pxAppId / _px cookies present). This
    // row answers "can this browser load a PerimeterX-protected page at all".
        // NOTE: PerimeterX is stateful — measured: the vendor site rendered cleanly on a
    // first visit and answered "Access to this page has been denied" after repeated
    // automated visits from this IP. A blocked reading therefore reflects the probing
    // cadence as much as the browser, and must not be read as an engine difference.
    id: 'perimeterx',
    url: 'https://www.humansecurity.com/',
    kind: 'perimeterx',
    driftGuard: /site not found|page not found|broken link/i,
    verdict: `(() => {
      const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
      let cookies = '';
      try { cookies = document.cookie; } catch (error) { cookies = ''; }
      const marked = Boolean(window._pxAppId || window._pxUuid || /_px/.test(cookies) || [...document.querySelectorAll('script[src]')].some((s) => /perimeterx|px-cdn/i.test(s.src)));
      const challenge = Boolean(document.querySelector('#px-captcha, iframe[src*="perimeterx"], iframe[src*="px-cdn"], iframe[title*="Human"], iframe[title*="Press"]')) || /press & hold|hold to confirm|请按住/i.test(text);
      if (/access to this page has been denied|request blocked/i.test(text)) return { state: 'blocked', detail: text.slice(0, 60) };
      if (challenge) return { state: 'challenge', detail: 'PX challenge shown' };
      return marked ? { state: 'pass', detail: 'HUMAN-protected page rendered, no challenge' } : { state: 'unknown', detail: 'no PerimeterX markers' };
    })()`,
  },
  {
    // The harder half of the same system on a measured challenge-serving target:
    // zillow.com serves the PX challenge iframe. Passing the first row says nothing
    // about this one, which is why they are separate rows.
    id: 'perimeterx-challenge',
    url: 'https://www.zillow.com/',
    kind: 'perimeterx',
    verdict: `(() => {
      const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
      const challenge = Boolean(document.querySelector('#px-captcha, iframe[src*="perimeterx"], iframe[src*="px-cdn"], iframe[title*="Human"], iframe[title*="Press"]')) || /press & hold|hold to confirm|请按住/i.test(text);
      if (/access to this page has been denied|request blocked/i.test(text)) return { state: 'blocked', detail: text.slice(0, 60) };
      if (challenge) return { state: 'challenge', detail: 'PX challenge iframe' };
      return { state: 'pass', detail: 'no challenge served' };
    })()`,
  },
  {
    id: 'akamai',
    url: 'https://www.akamai.com/',
    kind: 'akamai',
    verdict: `(() => { const t = (document.title + ' ' + (document.body.innerText || '')).slice(0, 200); const denied = /access denied|reference #|akamai/i.test(t) && /denied|reference #/i.test(t); return { state: denied ? 'blocked' : 'pass', detail: document.title.slice(0, 40) }; })()`,
  },
  {
    id: 'baidu-search',
    url: 'https://www.baidu.com/s?wd=deepseek%20harness',
    kind: 'baidu',
    verdict: `(() => { const t = (document.title + ' ' + (document.body.innerText || '')).slice(0, 300); const wall = /安全验证|wappass|请输入验证码/i.test(t) || /wappass/i.test(location.href); const results = document.querySelectorAll('#content_left .result, .c-container').length; return { state: wall ? 'challenge' : results > 0 ? 'pass' : 'thin', detail: wall ? document.title.slice(0, 30) : results + ' results' }; })()`,
  },
  {
    id: 'zhihu',
    url: 'https://www.zhihu.com/signin',
    kind: 'zhihu',
    verdict: `(() => { const t = (document.title + ' ' + (document.body.innerText || '')).slice(0, 300); const wall = /安全验证|异常|验证码|captcha/i.test(t); const form = document.querySelector('input[name="username"], .SignFlow, form'); return { state: wall && !form ? 'challenge' : 'pass', detail: (wall ? 'wall: ' : 'form: ') + document.title.slice(0, 30) }; })()`,
  },
  {
    id: 'geetest-slider',
    url: 'https://www.geetest.com/demo/slide-bind.html',
    kind: 'geetest',
    interactive: { handle: '.geetest_slider_button, .geetest_btn', track: '.geetest_slider, .geetest_panel' },
    verdict: `(() => { const panel = document.querySelector('.geetest_panel, .geetest_window, .geetest_slider'); const ok = document.querySelector('.geetest_success_radar_tip, .geetest_success'); const tip = document.querySelector('.geetest_tip_content, .geetest_result_tip'); return { state: ok ? 'pass' : panel ? 'challenge' : 'unknown', detail: (tip ? tip.innerText : document.title).slice(0, 40) }; })()`,
  },
  {
    id: 'yidun-jigsaw',
    url: 'https://dun.163.com/trial/jigsaw',
    kind: 'yidun',
    interactive: { handle: '.yidun_slider, .yidun_jigsaw', track: '.yidun_control, .yidun_panel' },
    verdict: `(() => { const panel = document.querySelector('.yidun_panel, .yidun_popup, .yidun_control, .yidun_intellisense'); const ok = document.querySelector('.yidun_success, .yidun_verify_success, .yidun--success'); return { state: ok ? 'pass' : panel ? 'challenge' : 'unknown', detail: (panel ? 'panel present' : document.title).slice(0, 40) }; })()`,
  },
  {
    // Measured: login.1688.com serves the Aliyun NC slider (#nc_1_wrapper plus the
    // alicdn nc script). 12306's login page no longer does, which is why this row
    // used to read "unknown" — that was a target problem, not an engine result.
        // NOTE: the NC widget appears while the slider waits ("请按住滑块"), so success
    // must be read from the text, never from the container's presence.
    id: 'aliyun-nc',
    url: 'https://login.1688.com/member/signin.htm',
    kind: 'aliyun',
    interactive: { handle: '#nc_1_n1z, .nc_iconfont.btn_slide', track: '#nc_1_wrapper, .nc_wrapper' },
    verdict: `(() => {
      const wrap = document.querySelector('#nc_1_wrapper, .nc_wrapper, #nc_1__scale_text');
      const handle = document.querySelector('#nc_1_n1z, .nc_iconfont.btn_slide');
      // Success is the TEXT, not the element: the container is present (reading
      // "拖动到最右边") while the slider is still waiting — matching it called every
      // page verified in 0.9 s, which is how a false pass was caught.
      const scale = document.querySelector('#nc_1__scale_text, .nc-lang-cnt');
      const scaleText = scale ? (scale.innerText || '') : '';
      const done = Boolean(document.querySelector('.nc_ok, .nc_iconfont.nc_ok')) || /验证通过|通过验证|success/i.test(scaleText);
      if (done) return { state: 'pass', detail: 'NC verified: ' + scaleText.slice(0, 20) };
      if (wrap || handle) return { state: 'challenge', detail: 'NC slider waiting: ' + scaleText.slice(0, 24) };
      return { state: 'unknown', detail: 'no NC widget on this page' };
    })()`,
  },
  {
    id: 'weibo-login',
    url: 'https://weibo.com/login.php',
    kind: 'weibo',
    verdict: `(() => { const gt = /geetest/i.test(document.documentElement.outerHTML); const yd = /yidun/i.test(document.documentElement.outerHTML); const form = document.querySelector('input[name="username"], #loginname'); return { state: gt || yd ? 'challenge' : form ? 'pass' : 'unknown', detail: [gt ? 'geetest' : '', yd ? 'yidun' : '', form ? 'form' : ''].filter(Boolean).join('+') || document.title.slice(0, 30) }; })()`,
  },
  {
    id: 'sannysoft',
    url: 'https://bot.sannysoft.com/',
    kind: 'detector',
    verdict: `(() => { let n = 0; for (const tr of document.querySelectorAll('table tr')) { const cells = [...tr.querySelectorAll('td,th')]; if (cells.length < 2) continue; const bg = getComputedStyle(cells[1]).backgroundColor; const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(bg); if (m && +m[1] > 180 && +m[2] < 160 && +m[3] < 160) n += 1; } return { state: n === 0 ? 'pass' : 'flagged', detail: n + ' failed row(s)' }; })()`,
  },
  {
    id: 'creepjs',
    url: 'https://abrahamjuliot.github.io/creepjs/',
    kind: 'fingerprint',
    // creepjs is a fingerprinting page, not a gate: current versions no longer
    // print a "trust score", so scoring it pass/fail was measuring nothing. It is
    // kept as an INFORMATIONAL row — it always reports `unknown` plus the FP ID
    // and any automation words it used, and it is excluded from the pass counts.
    informational: true,
    verdict: `(() => {
      const text = document.body.innerText || '';
      const id = (text.match(/FP ID:\\s*([0-9a-f]{8})/i) || [])[1] ?? 'none';
      // Deliberately no word scan: creepjs's own UI contains words like "headless",
      // so searching the page text reports the tool's vocabulary, not a verdict
      // about this browser. The FP ID is what the page actually produces.
      return { state: 'unknown', detail: 'FP ' + id + ' (fingerprinting page: no pass/fail)' };
    })()`

  },
  {
    id: 'pixelscan',
    url: 'https://pixelscan.net/',
    kind: 'fingerprint',
    verdict: `(() => { const text = (document.body.innerText || '').replace(/\\s+/g, ' '); const consistent = /consistent|looks like a real|human/i.test(text); const inconsistent = /inconsistent|bot|automat/i.test(text); return { state: inconsistent && !consistent ? 'flagged' : consistent ? 'pass' : 'unknown', detail: text.slice(0, 60) }; })()`,
  },
  {
    id: 'browserscan',
    url: 'https://www.browserscan.net/bot-detection',
    kind: 'fingerprint',
    verdict: `(() => { const text = (document.body.innerText || '').replace(/\\s+/g, ' '); const normal = /you are (a )?(normal|human)|not a bot|no bot/i.test(text); const bot = /you are (a )?bot|automation detected|webdriver.*true/i.test(text); return { state: bot && !normal ? 'flagged' : normal ? 'pass' : 'unknown', detail: text.slice(0, 70) }; })()`,
  },
];

const TARGETS = ONLY.length > 0 ? ALL_TARGETS.filter((t) => ONLY.includes(t.id)) : ALL_TARGETS;
if (TARGETS.length === 0) {
  console.log(`no target matched ${ONLY.join(',')}`);
  process.exit(1);
}

rmSync(defaultRegistryPath(), { force: true });
const browser = new AgentBrowser({
  config: resolveConfig({ browser: engine, sweepIntervalSec: 3600, pointerSpeedPxPerSec: 1200 }),
  log: () => {},
});

const results = [];
console.log(`\n=== ${engine} / ${mode} ===\n`);
await browser.ensureStarted();

for (const target of TARGETS) {
  const row = { id: target.id, kind: target.kind, state: 'error', detail: '', informational: target.informational === true };
  const started = Date.now();
  try {
    await browser.navigate(target.url, { settleMs: 15_000 });
    // Poll to a terminal state instead of reading once: a v3 score appears
    // asynchronously (measured late on BOTH engines, which made an earlier run
    // report "unknown" when the token was actually issued), and Cloudflare's
    // interstitial clears itself after a few seconds.
    const TERMINAL = new Set(['pass', 'fail', 'blocked', 'flagged']);
    let verdict = null;
    let waited = 0;
    while (waited < 24_000) {
      verdict = await browser.evaluate(target.verdict);
      if (verdict) row.verdictSeen = true;
      if (TERMINAL.has(verdict?.state)) break;
      await new Promise((r) => setTimeout(r, 1500));
      waited += 1500;
    }
    const settledAfterMs = waited;
    row.settledAfterMs = settledAfterMs;
    // Slider-style systems only reveal a pass rate if the challenge is attempted.
    // The handle is found generically (known selector, else the leftmost small
    // draggable element inside the challenge container) because a hardcoded
    // selector simply did not match and made the attempt silently never happen.
    if (target.interactive && verdict?.state === 'challenge') {
      const box = await browser.evaluate(`(() => {
        const known = document.querySelector(${JSON.stringify(target.interactive.handle)});
        const container = document.querySelector(${JSON.stringify(target.interactive.track)}) || document.body;
        let handle = known;
        if (!handle) {
          const rect = container.getBoundingClientRect();
          const candidates = [...container.querySelectorAll('*')].filter((el) => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return r.width > 8 && r.width <= 70 && r.height > 8 && r.height <= 70 &&
              r.left < rect.left + rect.width * 0.45 &&
              /pointer|grab|move/.test(style.cursor + ' ' + style.webkitCursor);
          });
          handle = candidates.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0] ?? null;
        }
        if (!handle) return null;
        const r = handle.getBoundingClientRect();
        const track = container.getBoundingClientRect();
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          distance: Math.max(60, Math.round(track.width - r.width - 4)),
          label: (handle.className || handle.id || handle.tagName || '').toString().slice(0, 40),
        };
      })()`);
      if (box) {
        for (const speed of [1, 2]) {
          await browser.input({ action: 'drag', x: box.x, y: box.y, toX: box.x + box.distance, toY: box.y });
          await new Promise((r) => setTimeout(r, 3000));
          verdict = await browser.evaluate(target.verdict);
          row.attempted = true;
          row.handle = box.label;
          if (verdict?.state !== 'challenge') break;
          // A failed slide puts the handle back; retry once from where it is now.
          const again = await browser.evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(target.interactive.handle)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`);
          if (!again) break;
          box.x = again.x;
          box.y = again.y;
        }
      } else {
        row.attempted = false;
        row.attemptNote = 'no slider handle found';
      }
    }
    // Target drift: a page that says it does not exist cannot be scored as a pass,
    // a block or a challenge. Marking it unknown keeps it out of the tallies.
    const drifted = target.driftGuard && target.driftGuard.test(await browser.evaluate('document.body.innerText || document.title').catch(() => ''));
    if (drifted) {
      row.state = 'unknown';
      row.detail = 'target drift: the page served does not exist';
      // The navigate-and-settle timing was already recorded above.
      results.push(row);
      console.log(`  ${target.id.padEnd(16)} ${'unknown'.padEnd(12)} ${row.detail}`);
      continue;
    }
    row.state = verdict?.state ?? 'unknown';
    row.detail = String(verdict?.detail ?? '').slice(0, 90);
    if (settledAfterMs > 0 && row.state === 'pass') row.detail += ` (cleared in ${(settledAfterMs / 1000).toFixed(1)}s)`;
  } catch (error) {
    // Distinguish a failed navigation from a failed attempt: conflating them once
    // reported a slider site as unreachable when the real cause was a bug in the
    // measurement itself.
    row.state = row.verdictSeen ? 'attempt-error' : 'unreachable';
    row.detail = String(error?.message ?? error).slice(0, 90);
  }
  row.ms = Date.now() - started;
  results.push(row);
  console.log(`  ${row.id.padEnd(16)} ${String(row.state).padEnd(12)} ${String(row.ms).padStart(5)}ms  ${row.detail}`);
}

const summary = {
  engine,
  mode,
  at: new Date().toISOString(),
  // Informational rows are counted separately: they have no pass/fail meaning, so
  // folding them into `unknown` would make the pass rate look like a measurement
  // when it is not.
  counts: results.filter((r) => !r.informational).reduce((acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }), {}),
  informational: results.filter((r) => r.informational).map((r) => `${r.id}: ${r.detail}`),
  results,
};
mkdirSync('.dev', { recursive: true });
// A filtered re-run must not clobber the full quadrant: name it separately.
const file = join('.dev', `matrix-${engine}-${mode}${ONLY.length > 0 ? '-partial' : ''}.json`);
writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n  ${JSON.stringify(summary.counts)}`);
console.log(`  written: ${file}\n`);
await browser.dispose();
