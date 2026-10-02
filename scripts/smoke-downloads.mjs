/**
 * Download capture, proven against a server that really sends a file.
 *
 *   HOME=<workspace>/.dev/home node scripts/smoke-downloads.mjs
 *
 * A local HTTP server hands out `Content-Disposition: attachment`, so the test
 * owns both ends: nothing depends on a third-party host deciding to serve a file.
 * The assertions are about the FILE, not about a log line.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig, stateDir } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

const BODY = 'agent-browser download test\n';
const server = createServer((req, res) => {
  if (req.url?.startsWith('/file')) {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-disposition': 'attachment; filename="download-test.txt"',
      'content-length': String(Buffer.byteLength(BODY)),
    });
    res.end(BODY);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body><a id="dl" href="/file">download</a></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

rmSync(defaultRegistryPath(), { force: true });
const browser = new AgentBrowser({
  config: resolveConfig({ browser: 'chromium', sweepIntervalSec: 3600 }),
  log: () => {},
});

await browser.ensureStarted();
const status = browser.status();
check('the runtime reports where downloads go', typeof status.downloadDir === 'string' && status.downloadDir.length > 0, status.downloadDir);
const expected = join(status.downloadDir ?? stateDir(), 'download-test.txt');
rmSync(expected, { force: true });

// Navigating straight at the attachment is what a real download link does.
await browser.navigate(`http://127.0.0.1:${port}/file`, { settleMs: 8000 });
let seen = null;
for (let i = 0; i < 40 && !seen; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  seen = browser.downloads().items.find((item) => item.state === 'completed') ?? null;
}
check('the download is reported as completed', Boolean(seen), JSON.stringify(browser.downloads().items.at(-1) ?? null));
check('the file really exists on disk', existsSync(expected), expected);
if (existsSync(expected)) {
  check('the file content matches what the server sent', readFileSync(expected, 'utf8') === BODY, JSON.stringify(readFileSync(expected, 'utf8').slice(0, 40)));
}
check('the runtime names the saved path', seen?.path === expected, String(seen?.path));

// The click-a-link path must work too, not just a direct navigation.
rmSync(expected, { force: true });
await browser.navigate(`http://127.0.0.1:${port}/`, { settleMs: 6000 });
const link = await browser.evaluate(`(() => { const r = document.getElementById('dl').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
await browser.input({ action: 'click', x: link.x, y: link.y });
let clicked = false;
for (let i = 0; i < 40 && !clicked; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  clicked = existsSync(expected);
}
check('clicking a download link saves the file', clicked, `${expected}`);

const listed = await browser.evaluate('1');
check('the page is still usable after a download', listed === 1);


await browser.dispose();
await new Promise((resolve) => server.close(resolve));
console.log(`\n${failures === 0 ? 'DOWNLOADS_OK' : `DOWNLOADS_FAILED (${failures})`}`);
