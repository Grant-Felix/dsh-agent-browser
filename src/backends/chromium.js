/**
 * The Chromium backend: everything CDP-shaped, behind a semantic interface.
 *
 * The agent runtime owns the shared parts — the page registry, the two reclaim
 * hooks, persistence, viewport following, frame pacing, the HTTP face — and
 * talks to a backend only through the methods below. A second backend
 * (WebDriver BiDi, for Firefox) implements the same interface, so no engine
 * detail leaks into the runtime.
 *
 * The interface is deliberately SEMANTIC (`click`, `key`, `text`, `startFrames`)
 * rather than a passthrough of CDP method names: BiDi expresses the same actions
 * with entirely different messages, and only the backend should know that.
 */
import { RemoteClient, RemoteError, waitForJson } from '../remote.js';
import { planPath } from '../pointer.js';

/** Named keys, resolved to CDP key events. */
const KEY_TABLE = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};

/** Named modifiers to CDP's bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
const MODIFIER_MASK = { Alt: 1, AltLeft: 1, AltRight: 1, Control: 2, Ctrl: 2, ControlLeft: 2, ControlRight: 2, Meta: 4, Command: 4, MetaLeft: 4, MetaRight: 4, Shift: 8, ShiftLeft: 8, ShiftRight: 8 };

/** Accept a bitmask, a list of names, or nothing. */
function modifierMask(modifiers) {
  if (typeof modifiers === 'number' && Number.isFinite(modifiers)) return modifiers;
  if (!Array.isArray(modifiers)) return 0;
  return modifiers.reduce((mask, name) => mask | (MODIFIER_MASK[name] ?? 0), 0);
}

export class ChromiumBackend {
  static id = 'chromium';

  #client = null;
  /**
   * `sessionId -> the page's top-level frame id`.
   *
   * `Page.frameNavigated` and the loading events fire for every frame, so without
   * this a subframe speaks for the page (see #rememberMainFrame).
   */
  #mainFrames = new Map();
  #log;
  #humanize = true;
  /** Input-motion knobs (speed, tremor amplitude, model) read per movement. */
  #config;

  constructor({ log, config } = {}) {
    this.#log = typeof log === 'function' ? log : () => {};
    this.#config = config ?? {};
    this.#humanize = this.#config.humanizeInput !== false;
  }

  /** Jittered delay: uniform timing is itself a machine signal. */
  #pause(base, spread = 0) {
    if (!this.#humanize) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, base + Math.random() * spread));
  }

  /**
   * Move the pointer to (x, y) the way a hand would: a short curved path with
   * jittered intermediate points and uneven timing, instead of one teleport.
   *
   * Behavior-scored systems (reCAPTCHA v3, Turnstile interactive mode) evaluate
   * the session, and a teleporting cursor with perfectly uniform delays is one of
   * the cheapest things to detect. This is insurance rather than a measured win:
   * the demo endpoints reachable here auto-pass, so it cannot be shown to change
   * their verdict — it removes an obvious tell at negligible cost.
   */
  /** The shared human-pointer model; see `src/pointer.js`. */
  #planPath(from, to) {
    return planPath(from, to, {
      model: this.#config?.pointerModel ?? 'human',
      speedPxPerSec: this.#config?.pointerSpeedPxPerSec,
      jitter: this.#config?.pointerJitter,
    });
  }

  async #glideTo(sessionId, x, y, buttons = this.#pressed ? 1 : 0) {
    const from = this.#pointer;
    this.#pointer = { x, y };
    const button = buttons ? 'left' : 'none';
    if (!this.#humanize || !from || (this.#config?.pointerModel ?? 'human') === 'linear') {
      await this.#client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons, button }, sessionId);
      return;
    }
    for (const point of this.#planPath(from, { x, y }).points) {
      await this.#client.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: point.x, y: point.y, buttons, button },
        sessionId,
      );
      await this.#pause(point.delay, point.delay * 0.35);
    }
  }

  /**
   * Press and hold. Drags (and therefore slider CAPTCHAs, kanban boards, canvas
   * apps) need a held button: the old path only ever emitted button-less moves,
   * so a panel "drag" was a click followed by cursor motion with nothing held.
   */
  async press(sessionId, { x, y }) {
    await this.#glideTo(sessionId, x, y, 0);
    await this.#pause(25, 55);
    await this.#client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
      sessionId,
    );
    this.#pressed = true;
  }

  async release(sessionId, { x, y }) {
    if (x !== undefined && y !== undefined) await this.#glideTo(sessionId, x, y, 1);
    const point = this.#pointer ?? { x: 0, y: 0 };
    await this.#client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 },
      sessionId,
    );
    this.#pressed = false;
  }

  get id() {
    return ChromiumBackend.id;
  }

  get connected() {
    return this.#client?.connected === true;
  }

  /**
   * The complete argv for this engine.
   *
   * Every flag lives here rather than in the shared runtime, because the engines
   * disagree about almost all of them: Firefox rejects `--user-data-dir` and has
   * no `--no-first-run`, so a shared list cannot serve both.
   */
  args({ config, port, userDataDir, viewport }) {
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-startup-window',
      // Noise and background traffic have no place in an agent browser: keep the
      // measured frames and timings comparable between runs.
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate,BackForwardCache,AcceptCHFrame',
    ];
    // The engine renders offscreen so no desktop window is ever opened — the
    // Sidebar panel is the browser's head and supplies the screen. The offscreen
    // ozone platform is used INSTEAD OF the `--headless` flag: `--headless=new`
    // reports a "HeadlessChrome" User-Agent and a SwiftShader WebGL renderer
    // (measured: 4 of 58 detector rows failed), while this keeps the ordinary
    // Chrome User-Agent and the real GPU (0 of 58 failed).
    args.push('--ozone-platform=headless');
    // Only pin a window size when a fixed viewport was asked for. With AUTO the
    // engine picks its own, which is the honest default for a host that has no
    // idea what screen the user has.
    if (viewport?.width > 0 && viewport?.height > 0) args.push(`--window-size=${viewport.width},${viewport.height}`);
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
    args.push(...(config.extraArgs ?? []));
    return args;
  }

  /**
   * Wait until the engine's remote endpoint answers.
   * @param port - the debugging port it was told to use.
   * @returns engine info for the log.
   */
  async ready(port, timeoutMs) {
    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs });
    return { browser: version.Browser, webSocketDebuggerUrl: version.webSocketDebuggerUrl };
  }

  /** Establish the control channel. */
  async connect(info) {
    this.#client = await RemoteClient.connect(info.webSocketDebuggerUrl, { timeoutMs: 10_000 });
  }

  async close() {
    this.#client?.close();
    this.#client = null;
  }

  onTargetCrashed(listener) {
    return this.#client.on('Inspector.targetCrashed', () => listener());
  }

  // ------------------------------------------------------------------ pages

  /**
   * Create an EMPTY page. The caller attaches its load listener and then calls
   * {@link navigate}, so a fast page cannot finish before the listener exists.
   */
  async createPage() {
    const created = await this.#client.send('Target.createTarget', { url: 'about:blank' });
    const attached = await this.#client.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await this.#client.send('Page.enable', {}, sessionId);
    await this.#client.send('Runtime.enable', {}, sessionId);
    await this.#rememberMainFrame(sessionId);
    return { targetId: created.targetId, sessionId };
  }

  async closePage(targetId, sessionId) {
    if (sessionId) this.#mainFrames.delete(sessionId);
    await this.#client.send('Target.closeTarget', { targetId });
  }

  async navigate(sessionId, url) {
    await this.#client.send('Page.navigate', { url }, sessionId);
  }

  async reload(sessionId) {
    await this.#client.send('Page.reload', { ignoreCache: false }, sessionId);
  }

  async history(sessionId, delta) {
    const history = await this.#client.send('Page.getNavigationHistory', {}, sessionId);
    const entry = history.entries?.[(history.currentIndex ?? 0) + delta];
    if (!entry) return false;
    await this.#client.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sessionId);
    return true;
  }

  async evaluate(sessionId, expression) {
    const result = await this.#client.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed';
      throw new RemoteError(text);
    }
    return result.result?.value;
  }

  async screenshot(sessionId) {
    const result = await this.#client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
    return { format: 'png', data: result.data };
  }

  async setViewport(sessionId, { width, height }) {
    await this.#client.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  }

  // ------------------------------------------------------------------ input

  async click(sessionId, { x, y, clickCount = 1 }) {
    await this.#glideTo(sessionId, x, y);
    for (let i = 0; i < clickCount; i += 1) {
      await this.#pause(40, 90);
      await this.#client.send(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: i + 1 },
        sessionId,
      );
      // A real press is not instantaneous: hold briefly, then release.
      const dwell = Math.max(0, Number(this.#config.pressDwellMs ?? 60));
      await this.#pause(dwell, dwell * 0.5);
      await this.#client.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: i + 1 },
        sessionId,
      );
    }
  }

  async move(sessionId, { x, y }) {
    await this.#glideTo(sessionId, x, y);
  }

  async scroll(sessionId, { x, y, deltaX, deltaY }) {
    // Wheel input arrives in ticks, not as one huge jump.
    const ticks = this.#humanize ? Math.max(1, Math.min(6, Math.round(Math.abs(deltaY) / 120))) : 1;
    for (let i = 0; i < ticks; i += 1) {
      await this.#client.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x, y, deltaX: deltaX / ticks, deltaY: deltaY / ticks, button: 'none', buttons: 0 },
        sessionId,
      );
      if (i < ticks - 1) await this.#pause(18, 40);
    }
  }

  async text(sessionId, value) {
    if (!this.#humanize) {
      await this.#client.send('Input.insertText', { text: value }, sessionId);
      return;
    }
    // Per-character cadence with uneven gaps; a whole string appearing at once
    // is a typing-dynamics giveaway.
    const base = Math.max(8, Number(this.#config.typingIntervalMs) || 90);
    const spread = Math.max(0, Number(this.#config.typingJitterMs) || 70);
    for (const character of String(value)) {
      await this.#client.send('Input.insertText', { text: character }, sessionId);
      // An occasional longer pause: humans hesitate at word boundaries.
      const hesitation = character === ' ' && Math.random() < 0.25 ? base * (1.5 + Math.random()) : 0;
      await this.#pause(base, spread + hesitation);
    }
  }

  async key(sessionId, { key, modifiers = [] }) {
    const spec =
      KEY_TABLE[key] ??
      (/^.$/u.test(key) ? { key, code: '', windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key } : null);
    if (!spec) throw new RemoteError(`unsupported key "${key}"`);
    // CDP wants an int bitmask here, not the list of names callers pass. Sending
    // the array made every named key fail with "modifiers - int32 value expected"
    // (a latent bug: the panel sends no modifiers, so it only broke on named keys).
    const common = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers: modifierMask(modifiers),
    };
    if (spec.text) {
      await this.#client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: spec.text }, sessionId);
      await this.#client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }, sessionId);
      return;
    }
    await this.#client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common }, sessionId);
    await this.#client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }, sessionId);
  }

  // ------------------------------------------------------------------ frames

  /**
   * Start the engine's frame source. Every frame is acknowledged immediately —
   * Chrome stops sending until it is, so a slow consumer would freeze the page.
   * @param sessionId - the page.
   * @param options - `quality`, `maxWidth`, `maxHeight` (all optional).
   * @param onFrame - `({ data, width, height, token })`.
   */
  async startFrames(sessionId, options, onFrame) {
    this.#frameHandler = this.#client.on(
      'Page.screencastFrame',
      (params) => {
        if (!params?.data) return;
        void this.#client.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
        onFrame({
          data: params.data,
          width: params.metadata?.deviceWidth ?? null,
          height: params.metadata?.deviceHeight ?? null,
          token: params.sessionId,
        });
      },
      sessionId,
    );
    const params = { format: 'jpeg', everyNthFrame: 1 };
    if (options?.quality) params.quality = options.quality;
    if (options?.maxWidth) params.maxWidth = options.maxWidth;
    if (options?.maxHeight) params.maxHeight = options.maxHeight;
    await this.#client.send('Page.startScreencast', params, sessionId);
  }

  async stopFrames(sessionId) {
    this.#frameHandler?.();
    this.#frameHandler = null;
    try {
      await this.#client.send('Page.stopScreencast', {}, sessionId);
    } catch {
      // The target may already be gone.
    }
  }

  // ------------------------------------------------------------------ downloads

  /**
   * Send downloads to a directory and start reporting them.
   *
   * Browser-level command (no session): the behaviour applies to every page.
   * `eventsEnabled` is what makes `Browser.downloadWillBegin`/`downloadProgress`
   * arrive at all.
   */
  async setDownloadBehavior(directory) {
    await this.#client.send(
      'Browser.setDownloadBehavior',
      { behavior: 'allow', downloadPath: directory, eventsEnabled: true },
      undefined,
      10_000,
    );
  }

  /** Called when a download starts: `{ guid, url, suggestedFilename }`. */
  onDownloadStarted(listener) {
    return this.#client.on('Browser.downloadWillBegin', (params) => listener(params));
  }

  /** Called as a download progresses and when it finishes. */
  onDownloadProgress(listener) {
    return this.#client.on('Browser.downloadProgress', (params) => listener(params));
  }

  // ------------------------------------------------------------------ cookies

  /**
   * Write one cookie into the browser.
   *
   * Cookies belong to the browser, not to a page, but CDP takes the command on a
   * session, so any live session can carry the whole import.
   */
  async setCookie(sessionId, cookie) {
    const params = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
    };
    if (cookie.expires) params.expires = cookie.expires;
    if (cookie.sameSite) params.sameSite = cookie.sameSite;
    const result = await this.#client.send('Network.setCookie', params, sessionId, 10_000);
    return result?.success !== false;
  }

  /** Read cookies back, for verification (values are returned, never logged). */
  async getCookies(sessionId, { domain, urls } = {}) {
    const params = {};
    if (urls?.length) params.urls = urls;
    const result = await this.#client.send('Network.getCookies', params, sessionId, 10_000);
    const cookies = result?.cookies ?? [];
    return domain ? cookies.filter((cookie) => String(cookie.domain ?? '').includes(domain)) : cookies;
  }

  /** CDP acknowledges each frame inline; nothing is left to do here. */
  async ackFrame() {}

  #frameHandler = null;
  /** Last pointer position, so a glide starts where the hand already is. */
  #pointer = null;
  /** Whether the left button is currently held down (a drag in progress). */
  #pressed = false;

  // ------------------------------------------------------------------ events

  onLoad(sessionId, listener) {
    return this.#client.on('Page.loadEventFired', () => listener(), sessionId);
  }

  /**
   * Learn which frame is the page's top-level one.
   *
   * `Page.frameNavigated` and the two loading events fire for EVERY frame, so
   * without this a subframe could speak for the page. Measured on Bing: its
   * identity iframe navigates to https://www.bing.com/identity/idtokenv2, and the
   * plugin reported that as the page URL — the panel's address bar then showed a
   * token endpoint instead of the search results, which reads as "this site will
   * not display".
   * @param sessionId - the page session.
   */
  async #rememberMainFrame(sessionId) {
    try {
      const tree = await this.#client.send('Page.getFrameTree', {}, sessionId);
      const id = tree?.frameTree?.frame?.id;
      if (id) this.#mainFrames.set(sessionId, id);
    } catch {
      // Not fatal: the first parentless frameNavigated also records it.
    }
  }

  onNavigated(sessionId, listener) {
    return this.#client.on('Page.frameNavigated', (params) => {
      const frame = params?.frame;
      if (!frame?.url) return;
      // The main frame is the one without a parent.
      if (frame.parentId !== undefined) return;
      this.#mainFrames.set(sessionId, frame.id);
      listener(frame.url);
    }, sessionId);
  }

  onLoading(sessionId, listener) {
    // Subframe loads must not flap the page's loading state either.
    const isMain = (params) => {
      const main = this.#mainFrames.get(sessionId);
      if (main === undefined || params?.frameId === undefined) return true;
      return params.frameId === main;
    };
    const offStart = this.#client.on('Page.frameStartedLoading', (params) => {
      if (isMain(params)) listener(true);
    }, sessionId);
    const offStop = this.#client.on('Page.frameStoppedLoading', (params) => {
      if (isMain(params)) listener(false);
    }, sessionId);
    return () => {
      offStart();
      offStop();
    };
  }

  onDetached(sessionId, listener) {
    return this.#client.on(
      'Target.detachedFromTarget',
      (params) => {
        if (params?.sessionId === sessionId) listener();
      },
      sessionId,
    );
  }

  /**
   * Wait for the next load event. The caller attaches this BEFORE navigating:
   * attaching afterwards misses a fast page's event and then waits out the whole
   * budget (measured: a 1.1 s page reported 7.1 s).
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
      const off = this.#client.on('Page.loadEventFired', finish, sessionId);
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    });
  }
}
