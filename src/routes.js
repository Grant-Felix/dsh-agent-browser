/**
 * The panel's HTTP face.
 *
 * One prefix route under `/api/agent-browser` carries everything the Sidebar
 * panel needs: current status, a live frame stream (SSE), and a command
 * endpoint that runs the same operations the agent tools run.
 *
 * Security posture: the Web server binds loopback in this profile, and every
 * request that carries an `Origin` header must be same-origin. The route never
 * echoes file contents of its own; it only drives the managed browser.
 */
import { RemoteError } from './remote.js';

const PREFIX = '/api/agent-browser';
const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;

/** The set of commands the panel and the tools share. */
const COMMANDS = new Set([
  'start',
  'stop',
  'open',
  'reload',
  'back',
  'forward',
  'input',
  'read',
  'screenshot',
  'status',
  'pages',
  'close',
  'restore',
  'activate',
  'forget',
  'sweep',
  'viewport',
  'search',
  'engines',
  'probe',
  'import_logins',
  'cookies',
  'downloads',
]);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RemoteError('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (error) {
        reject(new RemoteError(`request body is not JSON: ${error?.message ?? error}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Run one command against the runtime. Shared by the HTTP route and the tools.
 * @param browser - the runtime.
 * @param command - `{ action, ... }`.
 * @param search - the search service; required for the search actions.
 * @returns the command result.
 */
export async function runCommand(browser, command, search) {
  const action = String(command?.action ?? 'status');
  switch (action) {
    case 'status':
      return { ok: true, ...browser.status() };
    case 'downloads':
      return { ok: true, ...browser.downloads() };
    case 'import_logins':
      return {
        ok: true,
        ...(await browser.importLogins({
          source: command.source,
          domains: Array.isArray(command.domains) ? command.domains : [],
          dryRun: command.dryRun !== false,
        })),
      };
    case 'cookies':
      return { ok: true, cookies: await browser.cookies({ domain: command.domain }) };
    case 'search':
      if (!search) throw new RemoteError('search is unavailable in this host');
      return { ok: true, ...(await search.search(command.query, command.engine)) };
    case 'engines':
      if (!search) throw new RemoteError('search is unavailable in this host');
      return { ok: true, engines: search.list(), ...search.snapshot() };
    case 'probe':
      if (!search) throw new RemoteError('search is unavailable in this host');
      return {
        ok: true,
        ...(await search.probe({
          engines: command.engines,
          query: command.query,
          timeoutMs: command.timeoutMs,
          select: command.select !== false,
        })),
      };
    case 'start':
      return { ok: true, ...(await browser.ensureStarted()) };
    case 'stop':
      return { ok: true, ...(await browser.stop('panel command')) };
    case 'open':
      return { ok: true, ...(await browser.navigate(command.url ?? '', { newPage: command.newPage === true })) };
    case 'reload':
      return { ok: true, ...(await browser.reload(command.page)) };
    case 'back':
      return { ok: true, ...(await browser.goHistory(-1, command.page)) };
    case 'forward':
      return { ok: true, ...(await browser.goHistory(1, command.page)) };
    case 'pages':
      return { ok: true, ...browser.status() };
    case 'close':
      return { ok: true, ...(await browser.closePage(command.page)) };
    case 'forget':
      // Close AND forget: the destructive counterpart of parking.
      return { ok: true, ...(await browser.forgetPage(command.page)) };
    case 'activate':
      // Restores a parked page, or focuses a live one — the panel's page chips.
      return { ok: true, ...(await browser.activatePage(command.page)) };
    case 'restore':
      return { ok: true, ...(await browser.restorePage(command.page)) };
    case 'sweep':
      return { ok: true, swept: await browser.sweep(), ...browser.status() };
    case 'viewport':
      return { ok: true, ...(await browser.setViewport({ width: command.width, height: command.height })) };
    case 'input': {
      const input = command.input;
      if (!input || typeof input !== 'object') {
        throw new RemoteError('action=input needs an `input` object, e.g. {"action":"click","nx":0.5,"ny":0.5}');
      }
      await browser.input(input);
      return { ok: true, ...browser.status() };
    }
    case 'read':
      return { ok: true, page: await browser.read(command.page) };
    case 'screenshot':
      return { ok: true, ...(await browser.screenshot(command.page)) };
    default:
      throw new RemoteError(`unsupported command "${action}"`);
  }
}

/** Answer one SSE stream subscription for the panel. */
function streamFrames(req, res, browser) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (event, data) => {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // The socket is gone; the close handler cleans up.
    }
  };

  // A panel is now displaying this browser. That has two consequences, and both
  // exist because "not displayed" is indistinguishable from headless here:
  //   1. the panel brings the browser up by itself, so it never shows an empty
  //      placeholder while the user is looking at it;
  //   2. the browser stops being a candidate for idle reclamation (see
  //      AgentBrowser.noteViewer / sweep).
  browser.noteViewer(1);
  if (browser.status().state !== 'running') {
    // Not awaited: the subscriber must get its first event immediately, and a
    // failure is reported through the status stream like any other start.
    Promise.resolve()
      .then(() => browser.ensureStarted())
      .catch(() => {});
  }

  send('status', browser.status());
  // Paint immediately with the page's last known frame. Without this a panel that
  // connects while the page sits still would stay blank until the page happens to
  // change — and "blank" is the one state this panel must never be in.
  const cached = browser.lastFrame?.();
  if (cached) send('frame', cached);
  const offFrame = browser.onFrame((frame) => send('frame', frame));
  const offMeta = browser.onMeta((meta) => send('meta', meta));
  const offStatus = browser.onStatus((status) => send('status', status));
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      try {
        res.write(': ping\n\n');
      } catch {
        // Ignored: the close handler is about to run.
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let released = false;
  const cleanup = () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    offFrame();
    offMeta();
    offStatus();
    browser.noteViewer(-1);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

/**
 * Register the panel route on the host's web server.
 *
 * The caller must pass an *active* `webServer`, obtained through
 * `ctx.inject(['webServer'], …)` — never `ctx.get('webServer')` during `apply`:
 * on a cold boot this plugin can be applied before the web server service
 * activates, and a lookup that early returns `undefined`, leaving the panel
 * route silently unregistered. Observed 2026-10-02 on a freshly started
 * `dsh web` (tools worked, the panel route 401'd) — which is why this takes the
 * service instead of a context.
 * @param webServer - the active web server service.
 * @param browser - the runtime.
 * @returns the disposer removing the route.
 */
export function registerRoutes(webServer, browser, search) {
  if (!webServer || typeof webServer.register !== 'function') {
    throw new RemoteError('the web server service is unavailable');
  }
  return webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'same-origin requests only' });
        return;
      }
      let pathname;
      try {
        pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      } catch {
        sendJson(res, 400, { ok: false, error: 'malformed request URL' });
        return;
      }
      const method = pathname.startsWith(`${PREFIX}/`) ? pathname.slice(PREFIX.length + 1) : '';

      if (req.method === 'GET' && method === 'status') {
        sendJson(res, 200, { ok: true, ...browser.status() });
        return;
      }
      if (req.method === 'GET' && method === 'stream') {
        streamFrames(req, res, browser);
        return;
      }
      if (req.method === 'POST' && method === 'command') {
        try {
          const body = await readJsonBody(req);
          if (!COMMANDS.has(String(body.action ?? 'status'))) {
            sendJson(res, 400, { ok: false, error: `unknown action "${body.action}"` });
            return;
          }
          const result = await runCommand(browser, body, search);
          sendJson(res, 200, result);
        } catch (error) {
          const status = error instanceof RemoteError ? 400 : 500;
          sendJson(res, status, { ok: false, error: error?.message ?? String(error) });
        }
        return;
      }
      sendJson(res, 404, { ok: false, error: `no such route: ${req.method} ${method || '/'}` });
    },
  });
}

/** The route prefix, exported so the client and docs cannot drift from it. */
export const ROUTE_PREFIX = PREFIX;
