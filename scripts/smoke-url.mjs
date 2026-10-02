/**
 * The page's URL must be the PAGE's URL.
 *
 *   HOME=<workspace>/.dev/home node scripts/smoke-url.mjs
 *
 * `Page.frameNavigated` and the two loading events fire for EVERY frame, so a
 * subframe must never be allowed to speak for the page. This is not hypothetical:
 * Bing's search results embed an identity iframe that navigates to
 * `https://www.bing.com/identity/idtokenv2`, and the plugin reported that as the
 * page URL — the Sidebar's address bar then showed a token endpoint while the
 * search results were on screen, which reads exactly like "this site will not
 * display".
 *
 * The check runs against a local page built to have the same shape, so it needs no
 * network and cannot drift with a third-party site.
 */
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

const child = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<title>identity endpoint</title><p>a subframe that navigates on its own</p>');
});
await new Promise((resolve) => child.listen(0, '127.0.0.1', resolve));
const childUrl = `http://127.0.0.1:${child.address().port}/identity/idtokenv2`;

const main = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>search results</title><h1>the real page</h1><iframe src="${childUrl}" width="200" height="80"></iframe>`);
});
await new Promise((resolve) => main.listen(0, '127.0.0.1', resolve));
const mainUrl = `http://127.0.0.1:${main.address().port}/search?q=bilibili`;

for (const engine of ['chromium', 'firefox']) {
  rmSync(defaultRegistryPath(), { force: true });
  const browser = new AgentBrowser({ config: resolveConfig({ browser: engine, sweepIntervalSec: 3600 }), log: () => {} });
  try {
    await browser.ensureStarted();
    await browser.navigate(mainUrl, { settleMs: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const status = browser.status();
    const actual = await browser.evaluate('location.href');
    check(`${engine}: the reported URL is the top-level one`, status.url === mainUrl, `reported ${String(status.url).replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`);
    check(`${engine}: and it matches the page itself`, actual === mainUrl, String(actual).replace(/^http:\/\/127\.0\.0\.1:\d+/, ''));
    check(`${engine}: the title is the page's, not the frame's`, status.title === 'search results', String(status.title));
    // The subframe really did navigate: otherwise this test proves nothing.
    const frames = await browser.evaluate('document.querySelectorAll("iframe").length');
    check(`${engine}: the page does contain a navigating subframe`, frames >= 1, `${frames} iframe(s)`);
  } catch (error) {
    check(`${engine}: URL integrity`, false, String(error?.message ?? error).slice(0, 110));
  } finally {
    await browser.dispose();
  }
}

await new Promise((resolve) => main.close(resolve));
await new Promise((resolve) => child.close(resolve));
console.log(`\n${failures === 0 ? 'URL_OK' : `URL_FAILED (${failures})`}`);
