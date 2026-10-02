/**
 * Which anti-bot systems can actually be measured from THIS host?
 *
 *   HOME=<workspace>/.dev/home node scripts/probe-challenges.mjs [headed]
 *
 * "Test everything" is only meaningful once the catalogue is known: some systems
 * are unreachable, some need an account, some show a challenge only after a login
 * attempt. This probes each candidate and reports what it is, so the measurement
 * matrix is built from facts instead of a wish list.
 */
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';

const headed = process.argv.includes('headed');

/** Candidate challenge surfaces: domestic (CN) and international. */
const CATALOGUE = [
  // --- international -------------------------------------------------------
  ['recaptcha-v3', 'https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php', 'recaptcha'],
  ['recaptcha-v2', 'https://www.google.com/recaptcha/api2/demo', 'recaptcha'],
  ['hcaptcha', 'https://accounts.hcaptcha.com/demo', 'hcaptcha'],
  ['turnstile', 'https://demo.turnstile.workers.dev/', 'turnstile'],
  ['cloudflare-bot', 'https://nowsecure.nl/', 'cloudflare'],
  ['datadome', 'https://datadome.co/', 'datadome'],
  ['perimeterx', 'https://www.humansecurity.com/', 'perimeterx'],
  ['akamai', 'https://www.akamai.com/', 'akamai'],
  ['sannysoft', 'https://bot.sannysoft.com/', 'detector'],
  ['areyouheadless', 'https://arh.antoinevastel.com/bots/areyouheadless', 'detector'],
  ['creepjs', 'https://abrahamjuliot.github.io/creepjs/', 'fingerprint'],
  ['pixelscan', 'https://pixelscan.net/', 'fingerprint'],
  ['browserscan', 'https://www.browserscan.net/bot-detection', 'fingerprint'],
  // --- domestic (CN) -------------------------------------------------------
  ['geetest-slide', 'https://www.geetest.com/demo/slide-bind.html', 'geetest'],
  ['geetest-demo', 'https://www.geetest.com/demo/', 'geetest'],
  ['tencent-captcha', 'https://007.qq.com/', 'tcaptcha'],
  ['yidun-jigsaw', 'https://dun.163.com/trial/jigsaw', 'yidun'],
  ['aliyun-captcha', 'https://help.aliyun.com/', 'aliyun'],
  ['baidu-search', 'https://www.baidu.com/s?wd=test', 'baidu'],
  ['zhihu-signin', 'https://www.zhihu.com/signin', 'zhihu'],
  ['bilibili-login', 'https://passport.bilibili.com/login', 'bilibili'],
  ['weibo-login', 'https://weibo.com/login.php', 'weibo'],
  ['12306-login', 'https://kyfw.12306.cn/otn/resources/login.html', '12306'],
];

/** Widget and wall fingerprints, so a verdict does not depend on wording. */
const INSPECT = `(() => {
  const html = document.documentElement.outerHTML;
  const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 500);
  const widgets = {
    recaptcha: /g-recaptcha|grecaptcha|recaptcha\\/api/i.test(html),
    hcaptcha: /hcaptcha/i.test(html),
    turnstile: /cf-turnstile|challenges\\.cloudflare/i.test(html),
    geetest: /geetest|gt_captcha|gee_?test/i.test(html),
    tcaptcha: /tcaptcha|TCaptcha|tencent captcha/i.test(html),
    yidun: /yidun|dun\\.163/i.test(html),
    aliyun: /nc_1_wrapper|aliyun.*captcha|nocaptcha|cf\\.aliyun/i.test(html),
    cloudflare: /cf-challenge|challenge-platform|cdn-cgi\\/challenge/i.test(html),
    datadome: /datadome|dd_cookie/i.test(html),
    perimeterx: /_px|perimeterx|px-captcha/i.test(html),
  };
  const walls = /captcha|unusual traffic|are you a robot|verify (that )?you are human|access denied|automated queries|403 - forbidden|验证码|安全验证|异常流量|人机验证|请进行验证|滑动|拖动滑块|拼图/i.test(text + ' ' + document.title);
  const iframes = [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 80)).filter(Boolean).slice(0, 4);
  return { title: document.title, url: location.href, text, widgets, walls, iframes, links: document.querySelectorAll('a[href^="http"]').length };
})()`;

rmSync(defaultRegistryPath(), { force: true });
const browser = new AgentBrowser({
  config: resolveConfig({ sweepIntervalSec: 3600 }),
  log: () => {},
});

console.log(`\n=== challenge catalogue reachability (${headed ? 'headed' : 'headless'}) ===\n`);
const rows = [];
for (const [name, url, kind] of CATALOGUE) {
  const started = Date.now();
  try {
    await browser.navigate(url, { settleMs: 15_000 });
    await new Promise((r) => setTimeout(r, 2500));
    const report = await browser.evaluate(INSPECT);
    const active = Object.entries(report.widgets ?? {})
      .filter(([, present]) => present)
      .map(([key]) => key);
    const verdict = report.walls ? 'wall' : active.length > 0 ? `widget:${active.join('+')}` : 'no-challenge';
    rows.push({ name, kind, verdict, ms: Date.now() - started, title: report.title, url: report.url });
    console.log(
      `  ${name.padEnd(18)} ${String(verdict).padEnd(26)} ${String(Date.now() - started).padStart(5)}ms  ${String(report.title).slice(0, 42)}`,
    );
    if (report.iframes?.length) console.log(`      iframes: ${report.iframes.join(' | ')}`);
  } catch (error) {
    rows.push({ name, kind, verdict: 'unreachable', ms: Date.now() - started, error: String(error?.message ?? error).slice(0, 90) });
    console.log(`  ${name.padEnd(18)} ${'unreachable'.padEnd(26)} ${String(Date.now() - started).padStart(5)}ms  ${String(error?.message ?? error).slice(0, 60)}`);
  }
}

const reachable = rows.filter((r) => r.verdict !== 'unreachable');
console.log(`\n  reachable: ${reachable.length}/${rows.length}`);
console.log(`  with a challenge or detector verdict: ${rows.filter((r) => r.verdict !== 'unreachable' && r.verdict !== 'no-challenge').length}`);
const dom = rows.filter((r) => ['geetest', 'tcaptcha', 'yidun', 'aliyun', 'baidu', 'zhihu', 'bilibili', 'weibo', '12306'].includes(r.kind));
console.log(`  domestic reachable: ${dom.filter((r) => r.verdict !== 'unreachable').length}/${dom.length}`);
await browser.dispose();
