/**
 * The Firefox backend: WebDriver BiDi behind the same interface as Chromium.
 *
 * Firefox 157 exposes **no CDP at all** (measured: `/json/version`, `/json/list`
 * and `/status` all 404 on the debugging port), so this is not a port of the CDP
 * code — it is the other protocol. The differences that matter:
 *
 * - a page is a `browsingContext`, and there is one session for all of them, so
 *   the runtime's `sessionId` IS the context id;
 * - events are subscribed explicitly (`session.subscribe`) and BiDi keeps the
 *   input-source state machine for us, so a drag needs no `buttons` bookkeeping;
 * - **there is no screencast**, so frames are polled with
 *   `browsingContext.captureScreenshot`. That is a real, measured difference:
 *   a few frames per second against CDP's event-driven stream.
 */
import { BidiClient, BidiError, bidiEvaluate } from '../bidi.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pause, planPath } from '../pointer.js';

/**
 * Named keys as WebDriver's private-use codepoints.
 *
 * Firefox's BiDi rejects a DOM key name: sending `value: 'ArrowRight'` fails with
 * "Expected `value` to be a string that represents single code point or grapheme
 * cluster". The codepoints below are single code points AND carry the meaning, so
 * they satisfy the validator and still press the right key.
 */
const KEY_CODEPOINTS = {
  Backspace: '\uE003',
  Tab: '\uE004',
  Enter: '\uE007',
  Escape: '\uE00C',
  Space: '\uE00D',
  PageUp: '\uE00E',
  PageDown: '\uE00F',
  End: '\uE010',
  Home: '\uE011',
  ArrowLeft: '\uE012',
  ArrowUp: '\uE013',
  ArrowRight: '\uE014',
  ArrowDown: '\uE015',
  Delete: '\uE017',
  Insert: '\uE016',
  Clear: '\uE005',
  Cancel: '\uE001',
};

/** Modifier names to the same codepoint scheme. */
const MODIFIER_CODEPOINTS = {
  Alt: '\uE00A',
  AltLeft: '\uE00A',
  AltRight: '\uE00A',
  Control: '\uE009',
  Ctrl: '\uE009',
  ControlLeft: '\uE009',
  ControlRight: '\uE009',
  Meta: '\uE03D',
  Command: '\uE03D',
  MetaLeft: '\uE03D',
  MetaRight: '\uE03D',
  Shift: '\uE008',
  ShiftLeft: '\uE008',
  ShiftRight: '\uE008',
};

/** Read width/height straight out of a PNG's IHDR chunk. */
function pngSize(base64) {
  try {
    const header = Buffer.from(base64.slice(0, 64), 'base64');
    if (header.length < 24 || header.readUInt32BE(0) !== 0x89504e47) return { width: null, height: null };
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } catch {
    return { width: null, height: null };
  }
}

export class FirefoxBackend {
  static id = 'firefox';

  #client = null;
  #log;
  #config;
  #humanize = true;
  /** Last pointer position, so a planned path starts where the hand already is. */
  #pointer = null;
  #pressed = false;
  #frameLoops = new Map();
  /** Contexts already brought to the foreground before input. */
  #activated = new Set();
  #listeners = new Map();

  constructor({ log, config } = {}) {
    this.#log = typeof log === 'function' ? log : () => {};
    this.#config = config ?? {};
    this.#humanize = this.#config.humanizeInput !== false;
  }

  get id() {
    return FirefoxBackend.id;
  }

  get connected() {
    return this.#client?.connected === true;
  }

  /**
   * The complete argv for Firefox.
   *
   * Chrome's `--user-data-dir` and `--no-first-run` do not exist here; the
   * equivalent is `--profile`. `--no-remote` stops Firefox from handing the URL
   * to an already-running instance, which would silently ignore our port.
   */
  args({ config, port, userDataDir, viewport }) {
    // NOTE: this used to write `dom.webdriver.enabled=false` into the profile.
    // Measured on this build, that pref (and `marionette.enabled`) no longer
    // control `navigator.webdriver` at all — with the Remote Agent on it stays
    // true whatever the profile says. The property is overridden instead, in
    // `connect()` via a BiDi preload script; see the config's documentation.
    const args = [];
    // Firefox has no offscreen ozone platform, so `--headless` is its only way to
    // render without a desktop window. Measured cost on this build: none — its
    // detector failures are the same 2 rows either way (a Chrome-only object test
    // and `navigator.webdriver`, which this backend overrides).
    args.push('--headless');
    args.push('--no-remote', `--remote-debugging-port=${port}`, '--profile', userDataDir);
    if (viewport?.width > 0 && viewport?.height > 0) {
      args.push('--width', String(viewport.width), '--height', String(viewport.height));
    }
    args.push(...(config.extraArgs ?? []));
    args.push('about:blank');
    return args;
  }

  /**
   * Readiness: Firefox answers the debugging port with an HTTP error rather than
   * a JSON endpoint, so "the port answers at all" is the signal.
   */
  async ready(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = 'no attempt';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, {
          signal: AbortSignal.timeout(Math.min(2000, Math.max(500, deadline - Date.now()))),
        });
        if (response.status < 500) {
          return { browser: 'firefox', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/session` };
        }
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = error?.message ?? String(error);
      }
      await pause(200);
    }
    throw new BidiError(`firefox debugging port ${port} did not answer within ${timeoutMs}ms (last: ${last})`);
  }

  async connect(info) {
    this.#client = await BidiClient.connect(info.webSocketDebuggerUrl, { timeoutMs: 15_000 });
    if (this.#client.sessionError) this.#log(`bidi session.new reported: ${this.#client.sessionError}`);
    const accepted = await this.#client.subscribe();
    this.#log(`bidi subscribed to ${accepted.length} event(s): ${accepted.join(', ') || 'none'}`);
    for (const event of accepted) {
      this.#client.on(event, (params) => this.#dispatchEvent(event, params));
    }
    if (this.#config.hideWebdriver !== false) {
      // A BiDi preload script runs before any page script, so the override is in
      // place for every document from the first one on. Without it Firefox
      // announces `navigator.webdriver === true` purely because the Remote Agent
      // is on — Chromium never reports that here, because this project does not
      // pass `--enable-automation`.
      try {
        const script = await this.#client.send(
          'script.addPreloadScript',
          {
            functionDeclaration: `() => {
              // Detectors do not only read the value: the common check is
              // \`navigator.webdriver || 'webdriver' in navigator\` (read straight
              // out of bot.sannysoft.com's own source). A getter that returns false
              // still leaves the property present, so it still fails. Removing the
              // property is what makes both halves false.
              try { delete Navigator.prototype.webdriver; } catch (error) {}
              try { delete navigator.webdriver; } catch (error) {}
              if ('webdriver' in navigator) {
                try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); } catch (error) {}
                try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch (error) {}
              }
              // The WebDriver spec has the remote end mark the document element;
              // strip that too, since it is another "this is automation" tell.
              try { document.documentElement.removeAttribute('webdriver'); } catch (error) {}
              try { document.documentElement.removeAttribute('driver'); } catch (error) {}
            }`,
          },
          10_000,
        );
        this.#log(`navigator.webdriver override installed (bidi script ${script?.script ?? 'unknown'})`);
      } catch (error) {
        this.#log(`could not install the navigator.webdriver override: ${error?.message ?? error}`);
      }
    }
  }

  async close() {
    for (const [, loop] of this.#frameLoops) clearInterval(loop.timer);
    this.#frameLoops.clear();
    this.#client?.close();
    this.#client = null;
  }

  /** BiDi has no crash event this project can subscribe to. */
  onTargetCrashed() {
    return () => {};
  }

  // ------------------------------------------------------------------ pages

  async createPage() {
    const created = await this.#client.send('browsingContext.create', { type: 'tab' }, 15_000);
    const context = created?.context;
    if (!context) throw new BidiError('browsingContext.create returned no context');
    return { targetId: context, sessionId: context };
  }

  async closePage(targetId) {
    try {
      await this.#client.send('browsingContext.close', { context: targetId }, 10_000);
    } catch (error) {
      // A context that is already gone is not an error for the caller.
      if (!(error instanceof BidiError) || !/no such frame|unknown context/i.test(error.message)) throw error;
    }
  }

  async navigate(sessionId, url) {
    // `wait: 'none'` on purpose: the runtime attaches its load listener first and
    // waits itself, so blocking here would only duplicate the wait.
    await this.#client.send('browsingContext.navigate', { context: sessionId, url, wait: 'none' }, 20_000);
  }

  async reload(sessionId) {
    await this.#client.send('browsingContext.reload', { context: sessionId }, 20_000);
  }

  async history(sessionId, delta) {
    try {
      await this.#client.send('browsingContext.traverseHistory', { context: sessionId, delta }, 10_000);
      return true;
    } catch {
      return false;
    }
  }

  async evaluate(sessionId, expression) {
    return bidiEvaluate(this.#client, sessionId, expression, { timeoutMs: 20_000 });
  }

  async screenshot(sessionId) {
    const result = await this.#client.send(
      'browsingContext.captureScreenshot',
      { context: sessionId, format: { type: 'image/png' } },
      20_000,
    );
    if (!result?.data) throw new BidiError('captureScreenshot returned no data');
    return { format: 'png', data: result.data };
  }

  async setViewport(sessionId, { width, height }) {
    // A headed resize is negotiated with the window manager and can take much
    // longer than a headless one (measured: over 10 s while restoring a page).
    await this.#client.send(
      'browsingContext.setViewport',
      { context: sessionId, viewport: { width, height }, devicePixelRatio: 1 },
      12_000,
    );
  }

  // ------------------------------------------------------------------ input

  /**
   * Send one `input.performActions` batch.
   *
   * A headed Firefox whose window is not the active context can block this call
   * until it times out (measured: 20 s on the first click after a headed start,
   * the same shape as the headed `setViewport` hang). `browsingContext.activate`
   * is the standard way to put that context in the foreground, so it is called
   * once per page before the first input — and its failure is not fatal.
   */
  async #perform(sessionId, source) {
    if (!this.#activated.has(sessionId)) {
      this.#activated.add(sessionId);
      try {
        await this.#client.send('browsingContext.activate', { context: sessionId }, 5000);
      } catch (error) {
        this.#log(`could not activate ${sessionId} before input: ${error?.message ?? error}`);
      }
    }
    await this.#client.send('input.performActions', { context: sessionId, actions: [source] }, 20_000);
  }

  /**
   * Move the pointer along a planned path.
   *
   * BiDi animates a `pointerMove` over its `duration` and remembers the input
   * source's state, so the whole path goes in ONE batch — and a held button is
   * carried by the protocol rather than by flags this code has to track.
   */
  async #glideTo(sessionId, x, y) {
    const from = this.#pointer;
    this.#pointer = { x, y };
    const { points } = planPath(from, { x, y }, {
      model: this.#config?.pointerModel ?? 'human',
      speedPxPerSec: this.#config?.pointerSpeedPxPerSec,
      jitter: this.#config?.pointerJitter,
    });
    const planned = this.#humanize ? points : [{ x, y, delay: 0 }];
    await this.#perform(sessionId, {
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: planned.map((point) => ({
        type: 'pointerMove',
        x: Math.max(0, point.x),
        y: Math.max(0, point.y),
        duration: Math.max(0, Math.round(point.delay)),
        origin: 'viewport',
      })),
    });
  }

  async click(sessionId, { x, y, clickCount = 1 }) {
    await this.#glideTo(sessionId, x, y);
    const actions = [];
    for (let i = 0; i < clickCount; i += 1) {
      actions.push({ type: 'pointerDown', button: 0 });
      actions.push({ type: 'pointerUp', button: 0 });
      if (i < clickCount - 1) actions.push({ type: 'pause', duration: 40 });
    }
    await this.#perform(sessionId, {
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions,
    });
  }

  async move(sessionId, { x, y }) {
    await this.#glideTo(sessionId, x, y);
  }

  async press(sessionId, { x, y }) {
    await this.#glideTo(sessionId, x, y);
    await this.#perform(sessionId, {
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pause', duration: Math.max(0, Number(this.#config?.pressDwellMs ?? 60)) }, { type: 'pointerDown', button: 0 }],
    });
    this.#pressed = true;
  }

  async release(sessionId, { x, y }) {
    if (x !== undefined && y !== undefined) await this.#glideTo(sessionId, x, y);
    const point = this.#pointer ?? { x: 0, y: 0 };
    await this.#perform(sessionId, {
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pointerUp', button: 0 }],
    });
    this.#pressed = false;
    this.#pointer = point;
  }

  async scroll(sessionId, { x, y, deltaX, deltaY }) {
    const ticks = this.#humanize ? Math.max(1, Math.min(6, Math.round(Math.abs(deltaY) / 120))) : 1;
    const actions = [];
    for (let i = 0; i < ticks; i += 1) {
      actions.push({
        type: 'scroll',
        x: Math.max(0, Math.round(x ?? 0)),
        y: Math.max(0, Math.round(y ?? 0)),
        deltaX: Math.round(deltaX / ticks),
        deltaY: Math.round(deltaY / ticks),
        duration: 0,
        origin: 'viewport',
      });
      if (i < ticks - 1) actions.push({ type: 'pause', duration: 20 + Math.random() * 40 });
    }
    await this.#perform(sessionId, { type: 'wheel', id: 'wheel', actions });
  }

  async text(sessionId, value) {
    const base = Math.max(8, Number(this.#config?.typingIntervalMs) || 90);
    const spread = Math.max(0, Number(this.#config?.typingJitterMs) || 70);
    const actions = [];
    for (const character of String(value)) {
      actions.push({ type: 'keyDown', value: character });
      actions.push({ type: 'keyUp', value: character });
      const hesitation = character === ' ' && Math.random() < 0.25 ? base * (1.5 + Math.random()) : 0;
      if (this.#humanize) actions.push({ type: 'pause', duration: Math.round(base + Math.random() * (spread + hesitation)) });
    }
    await this.#perform(sessionId, { type: 'key', id: 'keyboard', actions });
  }

  async key(sessionId, { key, modifiers = [] }) {
    const named = KEY_CODEPOINTS[key] ?? (/^.$/u.test(key) ? key : null);
    if (!named) throw new BidiError(`unsupported key "${key}"`);
    const held = (Array.isArray(modifiers) ? modifiers : [])
      .map((name) => MODIFIER_CODEPOINTS[name])
      .filter(Boolean);
    const actions = [];
    for (const modifier of held) actions.push({ type: 'keyDown', value: modifier });
    actions.push({ type: 'keyDown', value: named });
    actions.push({ type: 'keyUp', value: named });
    for (const modifier of held.slice().reverse()) actions.push({ type: 'keyUp', value: modifier });
    await this.#perform(sessionId, { type: 'key', id: 'keyboard', actions });
  }

  // ------------------------------------------------------------------ frames

  /**
   * Start polling frames for one page.
   *
   * Firefox has no screencast, so this is a timer over `captureScreenshot`. The
   * measured consequence, stated plainly: a few frames per second instead of
   * CDP's pushed stream. The loop skips a tick while a capture is still running
   * so a slow page cannot pile up requests.
   */
  async startFrames(sessionId, options, onFrame) {
    this.stopFramesSync(sessionId);
    const fps = Math.max(1, Math.min(10, Number(options?.fps) || 3));
    const interval = Math.round(1000 / fps);
    const loop = { timer: null, busy: false };
    loop.timer = setInterval(() => {
      if (loop.busy || !this.connected) return;
      loop.busy = true;
      void this.#captureFrame(sessionId, options)
        .then((frame) => {
          if (frame) onFrame(frame);
        })
        .catch(() => {})
        .finally(() => {
          loop.busy = false;
        });
    }, interval);
    loop.timer.unref?.();
    this.#frameLoops.set(sessionId, loop);
    // One immediate frame so the panel is not blank until the first tick.
    const first = await this.#captureFrame(sessionId, options).catch(() => null);
    if (first) onFrame(first);
  }

  async #captureFrame(sessionId, options) {
    const shot = await this.#client.send(
      'browsingContext.captureScreenshot',
      { context: sessionId, format: { type: 'image/jpeg', quality: Number(options?.quality ?? 60) / 100 } },
      10_000,
    );
    if (!shot?.data) return null;
    const size = pngSize(shot.data);
    return { data: shot.data, width: size.width, height: size.height, token: null };
  }

  stopFramesSync(sessionId) {
    const loop = this.#frameLoops.get(sessionId);
    if (!loop) return;
    clearInterval(loop.timer);
    this.#frameLoops.delete(sessionId);
  }

  async stopFrames(sessionId) {
    this.stopFramesSync(sessionId);
  }

  // ------------------------------------------------------------------ downloads

  /**
   * WebDriver BiDi has no download command, so this engine cannot report them.
   * Refusing with that sentence beats a silent no-op that looks like support.
   */
  async setDownloadBehavior() {
    throw new BidiError('Firefox (WebDriver BiDi) has no download command, so download capture is unavailable on this engine');
  }

  onDownloadStarted() {
    return () => {};
  }

  onDownloadProgress() {
    return () => {};
  }

  // ------------------------------------------------------------------ cookies

  /**
   * Write cookies through BiDi's storage module.
   *
   * `storage.setCookies` is the standard command for this; whether a build
   * implements it is discovered by calling it, and a failure is reported instead
   * of being swallowed.
   */
  async setCookie(sessionId, cookie) {
    const spec = {
      name: cookie.name,
      value: { type: 'string', value: cookie.value },
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
    };
    if (cookie.expires) spec.expiry = cookie.expires;
    if (cookie.sameSite) spec.sameSite = cookie.sameSite;
    try {
      await this.#client.send('storage.setCookies', { cookies: [spec] }, 10_000);
      return true;
    } catch (error) {
      const text = String(error?.message ?? error);
      if (/unknown command|not implemented|unsupported|storage\.setCookies/i.test(text)) {
        throw new BidiError(`this Firefox build does not implement storage.setCookies (${text.slice(0, 120)})`);
      }
      throw error;
    }
  }

  async getCookies(sessionId, { domain } = {}) {
    const params = {};
    if (domain) params.filter = { domain };
    const result = await this.#client.send('storage.getCookies', params, 10_000);
    const cookies = result?.cookies ?? [];
    return cookies.map((cookie) => ({
      name: cookie.name,
      // BiDi returns bytes as {type:'string', value}.
      value: typeof cookie.value === 'string' ? cookie.value : cookie.value?.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
    }));
  }

  /** Nothing to acknowledge: frames are pulled, not pushed. */
  async ackFrame() {}

  // ------------------------------------------------------------------ events

  #listen(kind, context, listener) {
    let set = this.#listeners.get(kind);
    if (!set) {
      set = new Map();
      this.#listeners.set(kind, set);
    }
    let list = set.get(context);
    if (!list) {
      list = new Set();
      set.set(context, list);
    }
    list.add(listener);
    return () => {
      list.delete(listener);
    };
  }

  #emit(kind, context, payload) {
    const list = this.#listeners.get(kind)?.get(context);
    if (!list) return;
    for (const listener of [...list]) {
      try {
        listener(payload);
      } catch {
        // A listener must never break the event pump.
      }
    }
  }

  #dispatchEvent(event, params) {
    const context = params?.context;
    if (!context) return;
    if (event === 'browsingContext.load') {
      // One event carries both facts the runtime wants: the URL and "loaded".
      this.#emit('navigated', context, params.url ?? null);
      this.#emit('loading', context, false);
      this.#emit('load', context, null);
      return;
    }
    if (event === 'browsingContext.domContentLoaded') {
      this.#emit('loading', context, false);
      return;
    }
    if (event === 'browsingContext.navigationStarted') {
      this.#emit('navigated', context, params.url ?? null);
      this.#emit('loading', context, true);
      return;
    }
    if (event === 'browsingContext.contextDestroyed') {
      this.stopFramesSync(context);
      this.#emit('detached', context, null);
    }
  }

  onLoad(sessionId, listener) {
    return this.#listen('load', sessionId, listener);
  }

  onNavigated(sessionId, listener) {
    return this.#listen('navigated', sessionId, listener);
  }

  onLoading(sessionId, listener) {
    return this.#listen('loading', sessionId, listener);
  }

  onDetached(sessionId, listener) {
    return this.#listen('detached', sessionId, listener);
  }

  /**
   * Wait for the next load event. The caller attaches this BEFORE navigating:
   * attaching afterwards misses a fast page and then waits out the whole budget.
   */
  waitForLoad(sessionId, timeoutMs) {
    if (!this.connected) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        off();
        clearTimeout(timer);
        resolve();
      };
      const off = this.onLoad(sessionId, finish);
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    });
  }
}
