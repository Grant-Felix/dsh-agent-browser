/**
 * The agent browser runtime: one managed Chrome-Linux process, a registry of
 * pages, and a lifecycle policy that reclaims both.
 *
 * Two measured facts shape the design:
 *
 * - A live page costs roughly 245 MB, but Chromium reaps its renderer lazily —
 *   closing a target frees almost nothing for ~20 s. Parking pages is therefore
 *   worth doing for pages you are done with, not as an instant memory trick.
 * - A full browser stop releases ~1.4-2 GB immediately, and bringing a page back
 *   costs ~32 ms to create/attach plus a normal page load. So the aggressive
 *   hook (stop the browser) is the one that matters, and remembering page URLs
 *   on disk makes it invisible to the caller.
 *
 * The page registry is the single source of truth for pages, live or parked, and
 * is persisted to disk on every change so a stop can be undone on the next call.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createBackend, resolveEngineBinary } from './backends/index.js';
import { RemoteError } from './remote.js';
import { resolveDisplayMode, resolveUserDataDir, stateDir } from './config.js';
import { listCookieSources, readCookies } from './login-import.js';
import { defaultRegistryPath, readRegistry, writeRegistry } from './registry.js';

const STATE_FILE = 'browser.json';
const START_TIMEOUT_MS = 25_000;

/**
 * Identity, layout and human-verification detection in one page-side call.
 *
 * The wall markers are the ones measured in the wild: Sogou's anti-spider page
 * ("此验证码…"), Brave ("Captcha - …" in the title), Google (`/sorry/`), Baidu
 * (`wappass`), Mojeek ("automated queries"), plus the consent/interstitial
 * wording. A detected wall is surfaced to the user, never "solved" here.
 */
const META_AND_HUMAN_CHECK = `(() => {
  const body = document.body ? document.body.innerText : '';
  const text = body.slice(0, 4000).toLowerCase();
  const title = document.title || '';
  const href = location.href.toLowerCase();
  const textMarker = /captcha|unusual traffic|are you a robot|verify (that )?you are human|access denied|automated queries|403 - forbidden|antispider|robot check|enable javascript|before you continue|验证码|安全验证|异常流量|人机验证|反爬|请进行验证/i;
  const urlMarker = /\\/sorry|wappass|\\/captcha|antispider|antispam|antibot|\\/verify|challenge|consent\\.|\\/blocked/i;
  const detected = textMarker.test(text) || textMarker.test(title.toLowerCase()) || urlMarker.test(href);
  return {
    url: location.href,
    title: document.title,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    humanCheck: detected
      ? { detected: true, url: location.href, title: document.title, hint: body.replace(/\\s+/g, ' ').trim().slice(0, 160) }
      : { detected: false },
  };
})()`;

/** The page-side reading script: a compact page digest for the model. */
const READ_EXPRESSION = `(() => {
  const seen = new Set();
  const items = [];
  const selector = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]';
  for (const el of document.querySelectorAll(selector)) {
    if (items.length >= 200) break;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    const href = el.getAttribute('href') || undefined;
    const key = el.tagName + '|' + label + '|' + (href || '');
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      label: label || undefined,
      href,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    });
  }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 20000),
    interactive: items,
  };
})()`;

/** One managed browser. */
export class AgentBrowser {
  #config;
  #log;
  #registryPath;
  #state = 'stopped';
  #failure = null;
  #child = null;
  #port = null;
  #pages = new Map();
  #sequence = 0;
  #activeKey = null;
  #frameMeta = null;
  #meta = { url: '', title: '', loading: false };
  #frameListeners = new Set();
  #metaListeners = new Set();
  #statusListeners = new Set();
  #pendingFrame = null;
  #paceTimer = null;
  #lastEmitAt = 0;
  #lastActivityAt = 0;
  #sweepTimer = null;
  #starting = null;
  #ioUnsubscribes = [];
  /** Downloads seen this run: `{ guid, url, filename, path, state, bytes }`. */
  #downloads = [];
  /** Where downloads land, when the engine supports it at all. */
  #downloadDir = null;
  /**
   * The engine backend. Everything engine-specific (CDP for Chromium, WebDriver
   * BiDi for Firefox) lives behind this interface; the registry, the reclaim
   * hooks, persistence and frame pacing above it are engine-neutral.
   */
  #io;
  /** `{ mode, headed, desktopWindow, reason }` — one mode only, see the config. */
  #displayMode;
  /**
   * Connected panel streams.
   *
   * A connected panel means the browser is ON SCREEN, which is the whole point of
   * this plugin: "not displayed" is indistinguishable from headless, so a browser
   * someone is watching must not be reclaimed as idle. It also means the panel can
   * bring the browser up by itself, instead of showing an empty placeholder.
   */
  #viewers = 0;
  /**
   * Last frame emitted for each page (`key -> { data, width, height, ts }`).
   *
   * Chromium's screencast is damage-driven: a page that is not changing produces
   * no frames at all. A panel that connects while the page sits still would
   * therefore show an empty stage forever, which is exactly the "not displayed"
   * state this plugin must never be in — so the last frame of a page is kept and
   * replayed to every panel that arrives later.
   */
  #lastFrames = new Map();
  /**
   * The live viewport. `width`/`height` of 0 means AUTO: no override is applied
   * and the engine's own default stands. `source` records where the current
   * value came from, so a caller can tell a panel measurement from a config pin.
   */
  #viewport;
  /** True while an apply loop runs; a newer target waits in #viewportPending. */
  #viewportApplying = false;
  #viewportPending = null;

  constructor({ config, log, registryPath, backend }) {
    this.#config = config;
    this.#log = typeof log === 'function' ? log : () => {};
    this.#registryPath = registryPath ?? defaultRegistryPath();
    this.#io = backend ?? createBackend(config, this.#log);
    this.#viewport = {
      width: config.viewportWidth,
      height: config.viewportHeight,
      source: config.viewportWidth > 0 && config.viewportHeight > 0 ? 'config' : 'auto',
    };
  }

  /**
   * Resize every live page's viewport.
   *
   * The only real source of a size is the panel measuring its own column: no
   * screen size is assumed anywhere, because users run very different displays
   * and Sidebar widths. The configured rails are safety only — they reject
   * sizes no ordinary page survives, they do not express a preferred size.
   * @param size - desired viewport in device pixels, as measured by the panel.
   * @returns the applied viewport and the resulting status.
   */
  async setViewport(size) {
    // NOTE the spread order in every return below: `status()` carries its own
    // `viewport`, so the authoritative fields must come AFTER it. Putting them
    // first made the result report the previous size — caught by the assertions.
    if (this.#config.viewportFollowsPanel === false) {
      return {
        ok: true,
        ...this.status(),
        changed: false,
        ignored: 'viewportFollowsPanel is false',
        viewport: { ...this.#viewport },
      };
    }
    const width = clampViewport(
      size?.width,
      this.#config.viewportMinWidth,
      this.#config.viewportMaxWidth,
      this.#viewport.width,
    );
    const height = clampViewport(
      size?.height,
      this.#config.viewportMinHeight,
      this.#config.viewportMaxHeight,
      this.#viewport.height,
    );
    if (width === this.#viewport.width && height === this.#viewport.height && this.#viewport.source === 'panel') {
      return { ok: true, ...this.status(), changed: false, viewport: { ...this.#viewport } };
    }
    this.#viewport = { width, height, source: 'panel' };
    this.#viewportPending = { width, height };
    // A Sidebar drag fires a burst of resize events. Instead of queuing an apply
    // per event (each one a CDP round trip per page), the running loop picks up
    // only the newest target: N events cost at most two applies.
    if (this.#viewportApplying) {
      return { ok: true, ...this.status(), changed: true, coalesced: true, viewport: { ...this.#viewport } };
    }
    this.#viewportApplying = true;
    const unapplied = [];
    try {
      while (this.#viewportPending) {
        const target = this.#viewportPending;
        this.#viewportPending = null;
        for (const record of this.#pages.values()) {
          if (record.state !== 'live' || !record.sessionId || !this.#io?.connected) continue;
          if (record.viewport?.width === target.width && record.viewport?.height === target.height) continue;
          const applied = await this.#applyViewport(record);
          // Report, never fake: a page that kept its old size is named.
          if (!applied.applied && applied.reason !== 'AUTO') unapplied.push({ page: record.key, reason: applied.reason });
        }
      }
      // Re-read each live page's own layout once the size has SETTLED (not per
      // drag event). Resizing does not fire a load event, so without this the
      // page's self-reported size stayed at the pre-drag value — the drag trace
      // showed `page` pinned at 1147x1401 while `viewport`/`frame` moved.
      for (const record of this.#pages.values()) {
        if (record.state !== 'live' || !record.sessionId || !this.#io?.connected) continue;
        await this.#refreshMeta(record);
      }
    } finally {
      this.#viewportApplying = false;
    }
    this.#emitStatus();
    return {
      ok: true,
      ...this.status(),
      changed: true,
      viewport: { ...this.#viewport },
      ...(unapplied.length > 0 ? { unapplied } : {}),
    };
  }

  /**
   * Apply the viewport in the background, at most one attempt in flight per page.
   * @param record - the page to resize.
   */
  #scheduleViewport(record) {
    const screen = this.#screen();
    if (record.viewport?.width === screen.width && record.viewport?.height === screen.height) return;
    if (record.viewportApplying) return;
    record.viewportApplying = true;
    void this.#applyViewport(record).finally(() => {
      record.viewportApplying = false;
    });
  }

  /**
   * Apply the current viewport to one page.
   *
   * AUTO (0) means "no override": the page keeps the engine's own viewport,
   * which is what a host with no panel on screen should do.
   *
   * Failures are reported, not thrown: on a headed engine a resize is negotiated
   * with the window manager and can time out (measured: headed Firefox,
   * `browsingContext.setViewport` exceeded 10 s while restoring a page). Losing a
   * resize must not lose the page — the caller decides whether it is fatal.
   * @returns `{ applied, reason }`.
   */
  /**
   * The screen to use: the Sidebar's measured box when it has reported one,
   * otherwise the configured virtual screen. The panel is the browser's head, so
   * its box IS the screen; a 0x0 viewport renders nothing and no click can land,
   * which is why a fallback exists for the moment before the panel reports one.
   */
  #screen() {
    if (this.#viewport.width > 0 && this.#viewport.height > 0) return { ...this.#viewport };
    return { width: this.#config.virtualScreenWidth, height: this.#config.virtualScreenHeight, source: 'virtual' };
  }

  async #applyViewport(record) {
    const screen = this.#screen();
    if (screen.width <= 0 || screen.height <= 0) return { applied: false, reason: 'no screen' };
    try {
      await this.#io.setViewport(record.sessionId, { width: screen.width, height: screen.height });
      record.viewport = { width: screen.width, height: screen.height, source: screen.source };
      return { applied: true };
    } catch (error) {
      const reason = error?.message ?? String(error);
      this.#log(`could not apply ${screen.width}x${screen.height} to ${record.key}: ${reason}`);
      return { applied: false, reason };
    }
  }

  /** `stopped` | `starting` | `running` | `failed`. */
  get state() {
    return this.#state;
  }

  /** Start the browser if it is not running; safe to call concurrently. */
  async ensureStarted() {
    if (this.#state === 'running' && this.#io?.connected) return this.status();
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  /** Every page this runtime knows about, live or parked. */
  listPages() {
    const now = Date.now();
    return [...this.#pages.values()].map((record) => ({
      key: record.key,
      url: record.url,
      title: record.title,
      state: record.state,
      active: record.key === this.#activeKey,
      humanCheck: record.humanCheck?.detected === true,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      idleMs: now - record.lastUsedAt,
    }));
  }

  /** A snapshot of everything a caller (route, tool, panel) needs to know. */
  status() {
    const active = this.#pages.get(this.#activeKey);
    return {
      state: this.#state,
      failure: this.#failure,
      engine: this.#io.id,
      downloadDir: this.#downloadDir ?? null,
      downloads: [...this.#downloads],
      binary: resolveEngineBinary(this.#config) ?? null,
      userDataDir: resolveUserDataDir(this.#config),
      // One mode, stated in words rather than a boolean: the Sidebar panel is the
      // browser's head. There is no headless mode and no desktop-window mode, so a
      // `headless` flag would name something this plugin does not have.
      mode: (this.#displayMode ?? resolveDisplayMode()).mode,
      modeReason: (this.#displayMode ?? resolveDisplayMode()).reason,
      // How many panels are showing this browser right now.
      viewers: this.#viewers,
      // Which backend the state file says is up (only one may run at a time).
      backendRunning: this.#recordedBackend(),
      // The screen the browser is using: the panel's own box once it reports one.
      screen: this.#screen(),
      pid: this.#child?.pid ?? null,
      port: this.#port,
      url: active?.url ?? this.#meta.url,
      title: active?.title ?? this.#meta.title,
      loading: active?.loading ?? this.#meta.loading,
      // `viewport` is the size in force and where it came from ('auto' = no
      // override, the engine's own default); `frameViewport` is what the most
      // recent relayed frame actually measured (it lags a resize by one paint).
      // Keeping them apart stops a stale frame from masquerading as the setting.
      viewport: { width: this.#viewport.width, height: this.#viewport.height, source: this.#viewport.source },
      pageViewport: active?.layout ? { width: active.layout.width, height: active.layout.height } : null,
      frameViewport: this.#frameMeta
        ? { width: this.#frameMeta.deviceWidth, height: this.#frameMeta.deviceHeight }
        : null,
      activeKey: this.#activeKey,
      // A verification wall is a HUMAN's job: this project reports it instead of
      // pretending a control channel can clear it.
      humanCheck: active?.humanCheck ?? null,
      pages: this.listPages(),
      policy: {
        pageIdleTimeoutMin: this.#config.pageIdleTimeoutMin,
        browserIdleTimeoutMin: this.#config.browserIdleTimeoutMin,
        restoreOnDemand: this.#config.restoreOnDemand,
        maxLivePages: this.#config.maxLivePages,
        sweepIntervalSec: this.#config.sweepIntervalSec,
      },
      lastActivityAt: this.#lastActivityAt,
    };
  }

  /** Subscribe to relayed frames: `{ data, width, height, ts }`. */
  onFrame(listener) {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  /** Subscribe to navigation/title changes: `{ url, title, loading }`. */
  onMeta(listener) {
    this.#metaListeners.add(listener);
    return () => this.#metaListeners.delete(listener);
  }

  /** Subscribe to lifecycle changes: `status()`. */
  onStatus(listener) {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /**
   * Navigate a page.
   * @param url - target URL.
   * @param options - `newPage` opens a fresh page instead of reusing the active
   *   one; `page` names the page to navigate when not creating one; `settleMs`
   *   overrides the bounded wait for the load event (search probing measures
   *   navigation, so it needs its own budget).
   */
  async navigate(url, options = {}) {
    const settleMs = Number(options.settleMs) > 0 ? Number(options.settleMs) : 3000;
    if (options.newPage) {
      const created = await this.#openPage(url, settleMs);
      this.#touch(created);
      this.#persist();
      return this.status();
    }
    const record = await this.#requireActivePage();
    // Attach the load listener BEFORE sending the navigation. Attaching it
    // afterwards loses the event on a fast or cached page and then waits out the
    // whole budget (measured: a 1.1 s page reported 7.1 s), while probing
    // `readyState` afterwards can observe the PREVIOUS document and call the
    // navigation done (measured: a real engine reported 33 ms / 0 links).
    // Listening first has neither failure mode.
    const loaded = this.#waitForLoad(record, settleMs);
    await this.#io.navigate(record.sessionId, normalizeUrl(url));
    this.#touch(record);
    await loaded;
    await this.#refreshMeta(record);
    this.#persist();
    return this.status();
  }

  /**
   * Make one page the active (streaming/acting) page.
   *
   * Used by the search probe to hand the browser back to whatever the caller was
   * looking at before the test ran.
   * @param pageRef - the page to activate.
   * @returns the resulting status.
   */
  async activatePage(pageRef) {
    await this.#requireRunning();
    const record = this.#resolvePage(pageRef, { includeParked: true });
    if (!record) throw new RemoteError(`no such page "${pageRef}"`);
    if (record.state !== 'live') {
      await this.#restoreRecord(record);
      return this.status();
    }
    await this.#setActive(record);
    return this.status();
  }

  /** Reload one page (the active one by default). */
  async reload(pageRef) {
    const record = await this.#requireLivePage(pageRef);
    await this.#io.reload(record.sessionId);
    this.#touch(record);
    return this.status();
  }

  /**
   * Walk the navigation history.
   * @param delta - -1 for back, +1 for forward.
   * @param pageRef - which page; defaults to the active one.
   */
  async goHistory(delta, pageRef) {
    const record = await this.#requireLivePage(pageRef);
    const moved = await this.#io.history(record.sessionId, delta);
    if (!moved) return this.status();
    this.#touch(record);
    await this.#refreshMeta(record);
    this.#persist();
    return this.status();
  }

  /**
   * Evaluate an expression in a page and return its JSON value.
   *
   * Public entry points ensure the runtime is up first. Internal callers that
   * already run inside the startup path MUST use `#evaluateReady` instead —
   * awaiting `ensureStarted()` from inside its own start promise deadlocks.
   */
  async evaluate(expression, pageRef) {
    const record = await this.#requireLivePage(pageRef);
    const value = await this.#evaluateReady(record, expression);
    this.#touch(record);
    return value;
  }

  /** Evaluate on an already-live page. */
  async #evaluateReady(record, expression) {
    return this.#io.evaluate(record.sessionId, expression);
  }

  /** A compact page digest: url, title, text, and interactive elements. */
  async read(pageRef) {
    const record = await this.#requireLivePage(pageRef);
    const value = await this.#evaluateReady(record, READ_EXPRESSION);
    this.#touch(record);
    if (value?.url || value?.title) {
      record.url = value.url ?? record.url;
      record.title = value.title ?? record.title;
      if (record.key === this.#activeKey) this.#setMeta({ url: record.url, title: record.title });
      this.#emitStatus();
    }
    return { ...value, humanCheck: record.humanCheck ?? null };
  }

  /**
   * Import logins from a real browser profile into this browser.
   *
   * Cookies are browser-wide, so the import runs on any live page's session. It
   * is **dry by default**: a caller must ask for `dryRun: false` to actually copy
   * the user's sessions, and the report never contains cookie values.
   * @param options - `source` (substring of a store name), `domains` (suffix
   *   filter), `dryRun`, `limit`, `home`.
   * @returns a report: sources found, cookies read, written, failed.
   */
  async importLogins({ source, domains = [], dryRun = true, limit, home } = {}) {
    const sources = listCookieSources(home ? { home } : undefined);
    const chosen = source ? sources.filter((item) => item.name.includes(source) || item.file.includes(source)) : sources;
    const report = {
      dryRun: dryRun !== false,
      home: home ?? null,
      domains: Array.isArray(domains) ? domains : [],
      sources: sources.map((item) => ({ name: item.name, kind: item.kind, cookies: item.cookies, domains: item.domains })),
      chosen: chosen.map((item) => item.name),
      read: 0,
      imported: 0,
      failed: 0,
      perSource: [],
    };
    if (report.dryRun) return report;

    await this.ensureStarted();
    const record = await this.#requireLivePage();
    for (const item of chosen) {
      const result = readCookies(item, { domains: report.domains, limit: limit ?? 4000 });
      report.read += result.cookies.length;
      let imported = 0;
      let failed = 0;
      for (const cookie of result.cookies) {
        try {
          const written = await this.#io.setCookie(record.sessionId, cookie);
          if (written) imported += 1;
          else failed += 1;
        } catch (error) {
          failed += 1;
          if (failed === 1) report.firstError = String(error?.message ?? error).slice(0, 160);
        }
      }
      report.imported += imported;
      report.failed += failed;
      report.perSource.push({ name: item.name, kind: item.kind, scheme: result.scheme, read: result.cookies.length, imported, failed });
      this.#log(`logins: ${item.name} — ${imported}/${result.cookies.length} cookie(s) imported`);
    }
    this.#touch(record);
    return report;
  }

  /** Cookies currently in this browser, for verifying an import. */
  async cookies({ domain, urls } = {}) {
    await this.ensureStarted();
    const record = await this.#requireLivePage();
    // CDP returns only the cookies applicable to the CURRENT page when no URLs are
    // given, which silently hid every httpOnly session cookie on about:blank.
    // Asking for the domain's URLs is what makes the answer complete.
    const targets = urls ?? (domain ? [`https://${domain.replace(/^\./, '')}/`, `https://www.${domain.replace(/^\./, '')}/`] : undefined);
    const cookies = await this.#io.getCookies(record.sessionId, { domain, urls: targets });
    return cookies.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      valueLength: String(cookie.value ?? '').length,
    }));
  }

  /** A PNG screenshot of one page's viewport, base64-encoded. */
  async screenshot(pageRef) {
    const record = await this.#requireLivePage(pageRef);
    const shot = await this.#io.screenshot(record.sessionId);
    this.#touch(record);
    return { format: shot.format, data: shot.data, url: record.url, title: record.title };
  }

  /**
   * Dispatch one input command from the panel or a tool against the active page.
   * Coordinates are normalized (0..1) against the last relayed frame.
   */
  async input(command) {
    const record = await this.#requireLivePage();
    const session = record.sessionId;
    const action = String(command?.action ?? '');
    switch (action) {
      case 'up': {
        // A safety release may carry no coordinates: let the backend release
        // where the pointer actually is instead of jumping to (0,0).
        const hasPoint =
          (Number.isFinite(Number(command.x)) && Number.isFinite(Number(command.y))) ||
          (Number.isFinite(Number(command.nx)) && Number.isFinite(Number(command.ny)));
        await this.#io.release(session, hasPoint ? this.#toViewport(record, command) : {});
        break;
      }
      case 'drag': {
        // Press, travel a hand-like path with the button held, release. This is
        // the motion a slider CAPTCHA asks for, so it is one atomic action
        // rather than something a caller has to assemble from down/move/up.
        const hasTo =
          (Number.isFinite(Number(command.toX)) && Number.isFinite(Number(command.toY))) ||
          (Number.isFinite(Number(command.toNx)) && Number.isFinite(Number(command.toNy)));
        if (!hasTo) throw new RemoteError('action=drag needs toX/toY (CSS px) or toNx/toNy (0..1) for the drop point');
        const from = this.#toViewport(record, { x: command.x, y: command.y, nx: command.nx, ny: command.ny });
        const to = this.#toViewport(record, {
          x: command.toX,
          y: command.toY,
          nx: command.toNx,
          ny: command.toNy,
        });
        await this.#io.press(session, from);
        await this.#io.move(session, to);
        await this.#io.release(session, to);
        break;
      }
      case 'click':
      case 'doubleClick':
      case 'move':
      case 'down': {
        const { x, y } = this.#toViewport(record, command);
        if (action === 'move') await this.#io.move(session, { x, y });
        else if (action === 'down') await this.#io.press(session, { x, y });
        else await this.#io.click(session, { x, y, clickCount: action === 'doubleClick' ? 2 : 1 });
        break;
      }
      case 'scroll': {
        const { x, y } = this.#toViewport(record, command);
        await this.#io.scroll(session, {
          x,
          y,
          deltaX: Number(command.deltaX ?? 0),
          deltaY: Number(command.deltaY ?? 0),
        });
        break;
      }
      case 'text': {
        await this.#io.text(session, String(command.text ?? ''));
        break;
      }
      case 'key': {
        await this.#io.key(session, {
          key: String(command.key ?? ''),
          modifiers: Array.isArray(command.modifiers) ? command.modifiers : [],
        });
        break;
      }
      default:
        throw new RemoteError(`unsupported input action "${action}"`);
    }
    this.#touch(record);
    return { ok: true, action };
  }

  /**
   * Park one page: close its target and keep its URL in the registry.
   *
   * This is the "done with this page" hook. Chromium reaps the renderer lazily
   * (~20 s), so the memory shows up later; the URL survives and
   * {@link restorePage} brings it back for the price of a page load.
   * @param pageRef - which page; defaults to the active one.
   */
  async closePage(pageRef) {
    const record = this.#resolvePage(pageRef);
    if (!record) return { ok: false, reason: 'no such page', closed: null, ...this.status() };
    if (record.state !== 'live') {
      return { ok: true, reason: 'already parked', closed: { key: record.key, url: record.url }, ...this.status() };
    }
    await this.#parkPage(record, 'closed by caller');
    // `closed` names the page that was actually parked; status.url is the
    // active page, which is a different one when a non-active page is closed.
    return { ok: true, reason: 'parked', closed: { key: record.key, url: record.url }, ...this.status() };
  }

  /**
   * Bring a parked page (or the remembered active page) back to life.
   * @param pageRef - which remembered page; defaults to the active/remembered one.
   */
  async restorePage(pageRef) {
    await this.#requireRunning();
    const record = this.#resolvePage(pageRef, { includeParked: true });
    if (!record) return { ok: false, reason: 'nothing remembered to restore', restored: null, ...this.status() };
    if (record.state === 'live') {
      return { ok: true, reason: 'already live', restored: { key: record.key, url: record.url }, ...this.status() };
    }
    const live = await this.#restoreRecord(record);
    this.#touch(live);
    return { ok: true, reason: 'restored', restored: { key: live.key, url: live.url }, ...this.status() };
  }

  /**
   * Close a page AND forget it.
   *
   * Distinct from `closePage`, which parks: parking keeps the URL so the page can
   * come back, this removes the record entirely. The panel's tab menu offers both,
   * which is why the difference is spelled out in the answer rather than implied.
   * @param pageRef - which page; defaults to the active one.
   * @returns `{ ok, forgotten: { key, url } | null, reason }` plus status.
   */
  async forgetPage(pageRef) {
    const record = this.#resolvePage(pageRef, { includeParked: true });
    if (!record) return { ok: false, reason: 'no such page', forgotten: null, ...this.status() };
    if (record.state === 'live') await this.#parkPage(record, 'forgotten');
    this.#pages.delete(record.key);
    this.#lastFrames.delete(record.key);
    if (this.#activeKey === record.key) {
      const next = [...this.#pages.values()].find((page) => page.state === 'live') ?? [...this.#pages.values()][0] ?? null;
      this.#activeKey = next?.key ?? null;
      if (next && next.state === 'live') await this.#startScreencast(next);
    }
    this.#persist();
    this.#emitStatus();
    this.#log(`forgot page ${record.key} (${record.url})`);
    return { ok: true, reason: 'forgotten', forgotten: { key: record.key, url: record.url }, ...this.status() };
  }

  /**
   * Run the lifecycle policy once: park idle pages, enforce the live cap, and
   * stop the whole browser when nothing has used it for long enough.
   *
   * Exposed so the policy is testable without waiting hours, and so the panel
   * can offer a "reclaim now" action.
   * @param options - `now` overrides the clock (tests).
   * @returns what the sweep did.
   */
  /**
   * Record that a panel stream connected (`+1`) or went away (`-1`).
   *
   * While any panel is connected the browser is being displayed, and the sweep
   * leaves it alone: it neither stops the browser nor parks the page on screen,
   * because that would blank the panel the user is looking at.
   */
  noteViewer(delta) {
    this.#viewers = Math.max(0, this.#viewers + delta);
    return this.#viewers;
  }

  /** How many panels are currently displaying this browser. */
  get viewerCount() {
    return this.#viewers;
  }

  async sweep(options = {}) {
    const now = typeof options.now === 'number' ? options.now : Date.now();
    const result = { parked: [], stopped: false, reason: null, watched: this.#viewers > 0 };
    if (this.#state !== 'running') return result;

    const pageIdleMs = this.#config.pageIdleTimeoutMin * 60_000;
    if (pageIdleMs > 0) {
      for (const record of [...this.#pages.values()]) {
        if (record.state !== 'live') continue;
        // Never park the page a connected panel is showing.
        if (this.#viewers > 0 && record.key === this.#activeKey) continue;
        const idle = now - record.lastUsedAt;
        if (idle < pageIdleMs) continue;
        await this.#parkPage(record, `idle ${Math.round(idle / 60_000)} min`);
        result.parked.push(record.key);
      }
    }

    const cap = this.#config.maxLivePages;
    if (cap > 0) {
      // Recompute from the map on every step: parking mutates #pages, so
      // iterating one snapshot while removing entries would skip victims.
      const liveNow = () =>
        [...this.#pages.values()].filter((record) => record.state === 'live').sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      for (const victim of liveNow()) {
        if (liveNow().length <= cap) break;
        if (victim.key === this.#activeKey) continue;
        await this.#parkPage(victim, `live page cap ${cap}`);
        result.parked.push(victim.key);
      }
    }

    const browserIdleMs = this.#config.browserIdleTimeoutMin * 60_000;
    if (this.#viewers > 0) {
      // Someone is watching: this browser is in use by definition.
      result.reason = 'a panel is displaying this browser';
      return result;
    }
    if (browserIdleMs > 0 && this.#lastActivityAt > 0 && now - this.#lastActivityAt >= browserIdleMs) {
      result.stopped = true;
      result.reason = `idle ${Math.round((now - this.#lastActivityAt) / 60_000)} min`;
      await this.stop(result.reason);
    }
    return result;
  }

  /**
   * The backend recorded as running in the state file, when its process is alive.
   *
   * `browser.json` is the single source of truth for "which browser is up"; this
   * reads it without touching anything, so callers can see who holds the slot.
   * @returns `{ pid, port, engine }` or null.
   */
  #recordedBackend() {
    let record = null;
    try {
      record = JSON.parse(readFileSync(join(stateDir(), STATE_FILE), 'utf8'));
    } catch {
      return null;
    }
    if (!record?.pid) return null;
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if (error?.code !== 'EPERM') return null;
    }
    return { pid: record.pid, port: record.port ?? null, engine: record.engine ?? null };
  }

  /**
   * Refuse to start when the OTHER engine is already running.
   *
   * Only one backend may run in this profile at a time. The check lives here (and
   * not only in `#killStaleInstance`) because that method probes the old port with
   * THIS engine's protocol, which by construction fails across engines — a Firefox
   * left running would then never be seen, and two backends would run at once.
   * @returns a refusal message, or null when this engine may start.
   */
  #otherBackendConflict() {
    const running = this.#recordedBackend();
    if (!running || running.engine === null || running.engine === this.#io.id) return null;
    return `the ${running.engine} backend is already running (pid ${running.pid}${running.port ? `, port ${running.port}` : ''}) — only one backend may run at a time. Stop it first (the panel's "关闭"/stop control, or the tool's action=stop), then start ${this.#io.id}.`;
  }

  /** Stop the browser and drop every subscription. Remembered pages survive. */
  async stop(reason = 'stopped by caller') {
    this.#stopSweep();
    for (const unsubscribe of this.#ioUnsubscribes.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // A dying socket may already have removed listeners.
      }
    }
    for (const record of this.#pages.values()) {
      for (const unsubscribe of record.unsubscribes.splice(0)) {
        try {
          unsubscribe();
        } catch {
          // Ignored.
        }
      }
      record.state = 'parked';
      record.streaming = false;
      record.targetId = null;
      record.sessionId = null;
    }
    await this.#io.close();
    this.#frameMeta = null;
    const child = this.#child;
    this.#child = null;
    this.#port = null;
    if (child && child.pid) {
      await killTree(child);
    }
    this.#persist();
    rmSync(join(stateDir(), STATE_FILE), { force: true });
    this.#setState(this.#state === 'failed' ? 'failed' : 'stopped', this.#state === 'failed' ? this.#failure : null);
    this.#log(`agent browser stopped (${reason})`);
    return this.status();
  }

  /** Stop and forget all listeners — the plugin disposer path. */
  async dispose() {
    await this.stop('plugin disposed');
    this.#frameListeners.clear();
    this.#metaListeners.clear();
    this.#statusListeners.clear();
  }

  // ------------------------------------------------------------------ internals

  async #start() {
    // One backend at a time, enforced across processes: a second DSH session
    // configured for the other engine is told why instead of quietly starting a
    // competing browser (and, because panels auto-start their browser, refusing is
    // also what prevents two sessions from fighting over the slot).
    const conflict = this.#otherBackendConflict();
    if (conflict) {
      this.#setState('failed', conflict);
      this.#log(`start refused: ${conflict}`);
      return this.status();
    }
    const binary = resolveEngineBinary(this.#config);
    if (!binary) {
      this.#setState(
        'failed',
        this.#io.id === 'firefox'
          ? 'no Firefox binary found (set firefoxPath in the plugin config)'
          : 'no Chrome/Chromium binary found (set chromePath in the plugin config)',
      );
      return this.status();
    }
    const userDataDir = resolveUserDataDir(this.#config, this.#io.id);
    try {
      mkdirSync(userDataDir, { recursive: true });
      mkdirSync(stateDir(), { recursive: true });
    } catch (error) {
      this.#setState('failed', `cannot create the profile directory: ${error?.message ?? error}`);
      return this.status();
    }

    this.#setState('starting', null);
    this.#loadRemembered();
    await this.#killStaleInstance();

    const port = await freePort();
    // The display policy is applied here. Headless is refused while a display is
    // reachable, and the refusal carries its reason so callers can explain the
    // mode instead of silently getting something else.
    this.#displayMode = resolveDisplayMode();
    this.#log(`display mode: ${this.#displayMode.mode} — ${this.#displayMode.reason}`);
    // The backend owns the complete argv: the two engines share almost no flags.
    const args = this.#io.args({
      config: this.#config,
      port,
      userDataDir,
      viewport: this.#viewport,
    });

    let child;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      this.#setState('failed', `cannot spawn ${binary}: ${error?.message ?? error}`);
      return this.status();
    }
    this.#child = child;
    this.#port = port;
    child.unref?.();
    const stderrTail = [];
    child.stderr?.on('data', (chunk) => {
      stderrTail.push(String(chunk));
      if (stderrTail.length > 20) stderrTail.shift();
    });
    child.once('exit', (code, signal) => {
      const detail = `chrome exited (code=${code}, signal=${signal})`;
      if (this.#child === child) {
        this.#child = null;
        void this.#io?.close();
        if (this.#state === 'running' || this.#state === 'starting') {
              this.#setState('failed', detail);
        }
      }
    });

    try {
      const info = await this.#io.ready(port, START_TIMEOUT_MS);
      await this.#io.connect(info);
      this.#ioUnsubscribes.push(
        this.#io.onTargetCrashed(() => this.#setState('failed', 'a page target crashed')),
      );
      // Downloads: where they go and how we hear about them. Firefox has no such
      // command in BiDi, so a failure here is reported and the runtime continues.
      try {
        const downloadDir = this.#config.downloadDir || join(stateDir(), 'downloads');
        mkdirSync(downloadDir, { recursive: true });
        await this.#io.setDownloadBehavior(downloadDir);
        this.#downloadDir = downloadDir;
        this.#ioUnsubscribes.push(this.#io.onDownloadStarted((event) => this.#onDownloadStarted(event)));
        this.#ioUnsubscribes.push(this.#io.onDownloadProgress((event) => this.#onDownloadProgress(event)));
      } catch (error) {
        this.#log(`download capture unavailable: ${error?.message ?? error}`);
      }
      writeFileSync(
        join(stateDir(), STATE_FILE),
        JSON.stringify({ pid: child.pid, port, engine: this.#io.id, binary, startedAt: new Date().toISOString() }, null, 2),
      );
      await this.#reviveAfterStart();
      this.#lastActivityAt = Date.now();
      this.#startSweep();
      this.#setState('running', null);
      this.#log(`agent browser started (pid=${child.pid}, port=${port}, ${this.listPages().length} page(s) remembered)`);
      return this.status();
    } catch (error) {
      const detail = error?.message ?? String(error);
      const stderr = stderrTail.join('').trim().slice(-600);
      this.#setState('failed', stderr ? `${detail} — chrome stderr: ${stderr}` : detail);
      await this.stop('startup failed');
      return this.status();
    }
  }

  /**
   * Bring the page registry back to life after a cold start: reopen the page
   * that was active when the browser stopped, or the most recently used one.
   * A remembered page is only a URL, so this costs one page load.
   */
  async #reviveAfterStart() {
    const remembered = [...this.#pages.values()];
    if (!this.#config.restoreOnDemand || remembered.length === 0) {
      const created = await this.#createPage(this.#config.startUrl);
      await this.#setActive(created);
      this.#persist();
      return;
    }
    const preferred =
      remembered.find((record) => record.key === this.#activeKey) ??
      remembered.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    const live = await this.#createPage(preferred.url, { key: preferred.key });
    live.createdAt = preferred.createdAt;
    this.#pages.set(preferred.key, live);
    await this.#setActive(live);
    this.#persist();
  }

  /** Create one page target and wire its events. */
  async #createPage(url, options = {}) {
    const target = normalizeUrl(url);
    // The page is created EMPTY and navigated deliberately below, so the load
    // listener can be attached first. Creating it with the final URL races: a
    // fast page can finish before we attach, and a fresh about:blank reports
    // `readyState === 'complete'` — which looks loaded but is not (measured: a
    // real engine was recorded as "35 ms, 0 links, about:blank").
    const created = await this.#io.createPage();
    const now = Date.now();
    const record = {
      key: options.key ?? this.#nextKey(),
      targetId: created.targetId,
      sessionId: created.sessionId,
      url: target,
      title: '',
      loading: true,
      // The page's own innerWidth/innerHeight, learned on every meta refresh.
      // Used to resolve pointer ratios before the first frame arrives.
      layout: null,
      // Set when this page turns out to be a human-verification wall.
      humanCheck: null,
      createdAt: now,
      lastUsedAt: now,
      state: 'live',
      streaming: false,
      unsubscribes: [],
    };
    this.#pages.set(record.key, record);
    const session = record.sessionId;
    // The viewport is applied AFTER the page has loaded, not before: resizing a
    // brand-new tab is what a headed engine negotiates with the window manager,
    // and doing it before there is a document to lay out was measured hanging
    // (headed Firefox: setViewport on a fresh context never answered). The same
    // resize on a loaded page succeeds immediately.
    record.unsubscribes.push(
      this.#io.onNavigated(session, (url) => {
        // A fresh page reports about:blank before the requested URL commits.
        // Keeping the requested URL avoids reporting the transient blank
        // document as the page (observed: `open` reported "about:blank").
        if (url === 'about:blank' && record.url !== 'about:blank') return;
        record.url = url;
        if (record.key === this.#activeKey) this.#setMeta({ url: record.url });
        this.#emitStatus();
      }),
    );
    record.unsubscribes.push(
      this.#io.onLoad(session, () => {
        void this.#refreshMeta(record);
      }),
    );
    record.unsubscribes.push(
      this.#io.onLoading(session, (loading) => {
        record.loading = loading;
        if (record.key === this.#activeKey) this.#setMeta({ loading });
      }),
    );
    record.unsubscribes.push(
      this.#io.onDetached(session, () => {
        record.state = 'parked';
        record.targetId = null;
        record.sessionId = null;
        record.streaming = false;
        this.#emitStatus();
      }),
    );
    // Listener first, then navigate: no window in which the load is missed.
    const settleMs = Number(options.settleMs) > 0 ? Number(options.settleMs) : 3000;
    const loaded = this.#io.waitForLoad(session, settleMs);
    if (target !== 'about:blank') {
      await this.#io.navigate(session, target);
    }
    await loaded;
    // Not awaited: creating a page must never wait on a window-manager resize
    // (measured hanging on a headed Firefox tab). The size is retried after every
    // load instead, and a page that keeps the engine's default stays usable.
    this.#scheduleViewport(record);
    return record;
  }

  /** Restore a parked record under its own key. */
  async #restoreRecord(record) {
    const live = await this.#createPage(record.url, { key: record.key });
    live.createdAt = record.createdAt;
    this.#pages.set(record.key, live);
    await this.#setActive(live);
    this.#persist();
    this.#emitStatus();
    this.#log(`restored page ${live.key} (${live.url})`);
    return live;
  }

  /** Close a page's target but keep its URL; the registry entry becomes parked. */
  async #parkPage(record, reason) {
    if (record.state !== 'live') return;
    if (record.key === this.#activeKey) await this.#stopScreencast(record);
    try {
      await this.#io?.closePage(record.targetId, record.sessionId);
    } catch {
      // Already closed.
    }
    for (const unsubscribe of record.unsubscribes.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Ignored.
      }
    }
    record.state = 'parked';
    record.targetId = null;
    record.sessionId = null;
    this.#persist();
    this.#emitStatus();
    this.#log(`parked page ${record.key} (${reason}) — remembered ${record.url}`);
  }

  /** Make one page the streaming/acting page. */
  async #setActive(record) {
    if (this.#activeKey === record.key && record.state === 'live') {
      // Same page, but a restart-from-registry can arrive here with the key
      // already set and no screencast running, so the flag decides, not the key.
      if (!record.streaming) await this.#startScreencast(record);
      this.#setMeta({ url: record.url, title: record.title, loading: record.loading });
      return;
    }
    const previous = this.#pages.get(this.#activeKey);
    if (previous && previous.state === 'live' && previous.key !== record.key) {
      await this.#stopScreencast(previous);
    }
    this.#activeKey = record.key;
    if (record.state === 'live' && !record.streaming) await this.#startScreencast(record);
    this.#setMeta({ url: record.url, title: record.title, loading: record.loading });
    this.#persist();
  }

  /**
   * Frame-source options.
   *
   * `maxWidth`/`maxHeight` are caps and engines only ever scale down. When the
   * viewport is AUTO we do not know an aspect ratio, so `maxHeight` is omitted
   * rather than computed from a 0x0 viewport — that division produced NaN, CDP
   * answered "Invalid parameters" and the whole cold start failed.
   */
  #frameOptions() {
    const options = { quality: this.#config.jpegQuality, maxWidth: this.#config.maxWidth };
    // The aspect comes from the screen actually in use (panel or virtual), not
    // from the raw viewport field, which is 0 while the panel has not reported.
    const { width, height } = this.#screen();
    if (width > 0 && height > 0) options.maxHeight = Math.round((this.#config.maxWidth * height) / width);
    return options;
  }

  async #startScreencast(record) {
    await this.#io.startFrames(record.sessionId, this.#frameOptions(), (frame) => this.#onFrame(frame, record));
    record.streaming = true;
  }

  /** Stop feeding frames for one page; its target stays open. */
  async #stopScreencast(record) {
    if (!record.streaming) return;
    record.streaming = false;
    try {
      await this.#io.stopFrames(record.sessionId);
    } catch {
      // The socket or the target may already be gone.
    }
  }

  /** Open a brand-new page and make it active. */
  async #openPage(url, settleMs = 3000) {
    await this.#requireRunning();
    // #createPage attaches the load listener before navigating, so it already
    // waited; no second settle here.
    const record = await this.#createPage(url, { settleMs });
    await this.#setActive(record);
    this.#touch(record);
    await this.#refreshMeta(record);
    this.#persist();
    this.#emitStatus();
    return record;
  }

  /**
   * Wait (bounded) for one page's next load event. The caller must attach this
   * BEFORE issuing the navigation; see {@link navigate} for why.
   * @param record - the page to wait on.
   * @param timeoutMs - the cap; a page that never loads must not stall a call.
   */
  #waitForLoad(record, timeoutMs = 3000) {
    if (!this.#io?.connected || !record?.sessionId) return Promise.resolve();
    return this.#io.waitForLoad(record.sessionId, timeoutMs);
  }

  /**
   * Ensure the browser is up, or fail with the reason.
   *
   * Without this guard a failed start fell through to page creation and died on
   * `null.send` — a TypeError that hid the real cause (e.g. two instances
   * fighting over one profile directory).
   */
  async #requireRunning() {
    const status = await this.ensureStarted();
    if (this.#state !== 'running' || !this.#io?.connected) {
      throw new RemoteError(`the browser is not running (${this.#state})${status?.failure ? `: ${status.failure}` : ''}`);
    }
  }

  /** The active page, restoring it if it was parked. */
  async #requireLivePage(pageRef) {
    await this.#requireRunning();
    if (pageRef !== undefined && pageRef !== null && pageRef !== '') {
      const record = this.#resolvePage(pageRef, { includeParked: true });
      if (!record) throw new RemoteError(`no such page "${pageRef}"`);
      if (record.state === 'live') return record;
      return this.#restoreRecord(record);
    }
    const active = this.#pages.get(this.#activeKey);
    if (active?.state === 'live') return active;
    if (active) return this.#restoreRecord(active);
    const created = await this.#createPage(this.#config.startUrl);
    await this.#setActive(created);
    this.#persist();
    return created;
  }

  /** The active page, creating one if the registry is empty. */
  async #requireActivePage() {
    return this.#requireLivePage();
  }

  /**
   * Resolve a page reference: an exact key, a case-insensitive URL substring, or
   * a 1-based index. Without a reference, the active page wins.
   */
  #resolvePage(pageRef, options = {}) {
    const wanted = typeof pageRef === 'string' ? pageRef.trim() : pageRef;
    if (wanted === undefined || wanted === null || wanted === '') {
      const active = this.#pages.get(this.#activeKey);
      if (active) return active;
      const all = [...this.#pages.values()];
      return all.length > 0 ? all[all.length - 1] : undefined;
    }
    const all = [...this.#pages.values()].filter((record) => options.includeParked || record.state === 'live');
    const byKey = all.find((record) => record.key === wanted);
    if (byKey) return byKey;
    if (typeof wanted === 'number' || /^\d+$/.test(String(wanted))) {
      const index = Number(wanted);
      if (index >= 1 && index <= all.length) return all[index - 1];
    }
    const needle = String(wanted).toLowerCase();
    return all.find((record) => record.url.toLowerCase().includes(needle));
  }

  #nextKey() {
    this.#sequence += 1;
    return `p${this.#sequence}`;
  }

  /** Load remembered pages from disk into an empty registry. */
  #loadRemembered() {
    const stored = readRegistry(this.#registryPath);
    if (this.#pages.size === 0) {
      for (const page of stored.pages) {
        this.#pages.set(page.key, {
          key: page.key,
          targetId: null,
          sessionId: null,
          url: page.url,
          title: page.title,
          loading: false,
          createdAt: page.createdAt,
          lastUsedAt: page.lastUsedAt,
          state: 'parked',
          streaming: false,
          unsubscribes: [],
        });
        const suffix = Number.parseInt(page.key.replace(/^p/, ''), 10);
        if (Number.isFinite(suffix)) this.#sequence = Math.max(this.#sequence, suffix);
      }
    }
    if (stored.activeKey && this.#pages.has(stored.activeKey)) this.#activeKey = stored.activeKey;
    if (!this.#activeKey && this.#pages.size > 0) {
      this.#activeKey = [...this.#pages.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0].key;
    }
  }

  /** Persist the registry: every page's URL and recency, live or parked. */
  #persist() {
    const pages = [...this.#pages.values()].map((record) => ({
      key: record.key,
      url: record.url,
      title: record.title,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
    }));
    writeRegistry({ activeKey: this.#activeKey, pages }, this.#registryPath);
  }

  /** Mark a page and the whole browser as just used. */
  #touch(record) {
    const now = Date.now();
    this.#lastActivityAt = now;
    if (record) record.lastUsedAt = now;
  }

  #startSweep() {
    this.#stopSweep();
    const everyMs = Math.max(5, this.#config.sweepIntervalSec) * 1000;
    this.#sweepTimer = setInterval(() => {
      void this.sweep().catch((error) => this.#log(`sweep failed: ${error?.message ?? error}`));
    }, everyMs);
    this.#sweepTimer.unref?.();
  }

  #stopSweep() {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
  }

  /**
   * Pace and publish one frame from the backend.
   *
   * Pacing is engine-neutral policy (a frame budget plus "latest frame wins"),
   * so it stays here; acknowledging the source frame is the backend's job,
   * because only it knows whether its protocol needs an ack (CDP does).
   */
  #onFrame(frame, record) {
    if (!frame?.data) return;
    if (record.key !== this.#activeKey) return;
    // Size authority: the frame's own metadata, then the page's measured layout,
    // then a configured viewport. Never an assumed constant.
    const deviceWidth = frame.width ?? record.layout?.width ?? this.#viewport.width;
    const deviceHeight = frame.height ?? record.layout?.height ?? this.#viewport.height;
    if (deviceWidth > 0 && deviceHeight > 0) this.#frameMeta = { deviceWidth, deviceHeight };
    const next = { data: frame.data, width: deviceWidth, height: deviceHeight, ts: Date.now() };
    this.#lastFrames.set(record.key, next);
    const minInterval = 1000 / this.#config.fps;
    const elapsed = Date.now() - this.#lastEmitAt;
    if (elapsed >= minInterval) {
      this.#emitFrame(next);
      return;
    }
    this.#pendingFrame = next;
    if (this.#paceTimer) return;
    this.#paceTimer = setTimeout(() => {
      this.#paceTimer = null;
      const pending = this.#pendingFrame;
      this.#pendingFrame = null;
      if (pending) this.#emitFrame(pending);
    }, minInterval - elapsed);
  }

  /**
   * The most recent frame of the active page, or of a named page.
   *
   * Used to paint a panel the instant it connects instead of waiting for the page
   * to change (which, on a static page, may be never).
   * @param pageRef - which page; defaults to the active one.
   * @returns the cached frame or null.
   */
  lastFrame(pageRef) {
    const key = pageRef ?? this.#activeKey;
    return (key !== null && this.#lastFrames.get(key)) || null;
  }

  #emitFrame(frame) {
    this.#lastEmitAt = Date.now();
    for (const listener of [...this.#frameListeners]) {
      try {
        listener(frame);
      } catch {
        // A slow or dead subscriber must not stall the stream.
      }
    }
  }

  #onDownloadStarted(event) {
    const record = {
      guid: event?.guid ?? null,
      url: event?.url ?? null,
      filename: event?.suggestedFilename ?? null,
      path: this.#downloadDir && event?.suggestedFilename ? join(this.#downloadDir, event.suggestedFilename) : null,
      state: 'started',
      bytes: 0,
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.#downloads.push(record);
    if (this.#downloads.length > 50) this.#downloads.shift();
    this.#log(`download started: ${record.filename} (${record.url})`);
    this.#emitStatus();
  }

  #onDownloadProgress(event) {
    const record = this.#downloads.find((item) => item.guid === event?.guid);
    if (!record) return;
    if (Number.isFinite(event?.receivedBytes)) record.bytes = event.receivedBytes;
    if (event?.state === 'completed' || event?.state === 'canceled') {
      record.state = event.state;
      record.finishedAt = Date.now();
      this.#log(`download ${event.state}: ${record.filename}${record.path ? ` -> ${record.path}` : ''}`);
    }
    this.#emitStatus();
  }

  /** Every download seen this run, newest last. */
  downloads() {
    return { dir: this.#downloadDir ?? null, items: [...this.#downloads] };
  }

  async #refreshMeta(record) {
    if (!this.#io?.connected || !record.sessionId) return;
    try {
      // One round trip, three jobs: identity (url/title), the page's own layout
      // (so pointer ratios need no assumed size), and whether this page is a
      // human-verification wall — which the panel must surface so a person can
      // take over, because no control channel can prove humanity.
      const value = await this.#evaluateReady(record, META_AND_HUMAN_CHECK);
      // Same guard as frameNavigated: a still-loading page reports about:blank,
      // which must not replace the URL the caller asked for.
      if (value?.url && !(value.url === 'about:blank' && record.url !== 'about:blank')) record.url = value.url;
      record.title = value?.title ?? record.title;
      if (Number.isFinite(value?.innerWidth) && Number.isFinite(value?.innerHeight)) {
        record.layout = { width: value.innerWidth, height: value.innerHeight };
      }
      const check = value?.humanCheck ?? { detected: false };
      const changed = check.detected !== record.humanCheck?.detected || check.url !== record.humanCheck?.url;
      record.humanCheck = check.detected ? check : null;
      record.loading = false;
      // Retry a viewport that could not be applied when the page was created.
      if (record.viewport?.width !== this.#screen().width || record.viewport?.height !== this.#screen().height) {
        this.#scheduleViewport(record);
      }
      if (record.key === this.#activeKey) {
        this.#setMeta({ url: record.url, title: record.title, loading: false });
      }
      if (changed && check.detected) this.#log(`human verification detected on ${record.url}`);
      this.#persist();
      this.#emitStatus();
    } catch {
      // Navigation may be in flight; the next event refreshes it.
    }
  }

  #setMeta(patch) {
    const next = { ...this.#meta, ...patch };
    if (next.url === undefined) next.url = '';
    if (next.title === undefined) next.title = '';
    const changed = next.url !== this.#meta.url || next.title !== this.#meta.title || next.loading !== this.#meta.loading;
    this.#meta = next;
    if (!changed) return;
    for (const listener of [...this.#metaListeners]) {
      try {
        listener({ ...this.#meta });
      } catch {
        // Subscriber-local failure.
      }
    }
  }

  #emitStatus() {
    const status = this.status();
    for (const listener of [...this.#statusListeners]) {
      try {
        listener(status);
      } catch {
        // Subscriber-local failure.
      }
    }
  }

  #setState(state, failure) {
    const changed = state !== this.#state || failure !== this.#failure;
    this.#state = state;
    this.#failure = failure ?? null;
    if (!changed) return;
    this.#emitStatus();
  }

  /**
   * Convert normalized pointer coordinates to viewport pixels.
   *
   * The size comes from the page itself, in order of authority: the last relayed
   * frame, the page's own `innerWidth/innerHeight`, then a configured viewport.
   * There is deliberately no hardcoded fallback size: if none of those is known
   * the caller gets an explicit error instead of a click landing nowhere.
   */
  #toViewport(record, command) {
    const width = this.#frameMeta?.deviceWidth ?? record?.layout?.width ?? this.#viewport.width;
    const height = this.#frameMeta?.deviceHeight ?? record?.layout?.height ?? this.#viewport.height;
    const nx = Number(command.nx);
    const ny = Number(command.ny);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (!(width > 0) || !(height > 0)) {
        throw new RemoteError('the page viewport is not known yet; wait for the first frame before clicking by ratio');
      }
      return { x: Math.round(nx * width), y: Math.round(ny * height) };
    }
    return { x: Math.round(Number(command.x) || 0), y: Math.round(Number(command.y) || 0) };
  }

  async #killStaleInstance() {
    const path = join(stateDir(), STATE_FILE);
    let stale;
    try {
      stale = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return;
    }
    if (!stale?.port) return;
    // Ask the engine, not Chrome's HTTP surface: Firefox 404s /json/version, so
    // probing that endpoint would leave a stale Firefox running forever.
    try {
      await this.#io.ready(stale.port, 1200);
    } catch {
      rmSync(path, { force: true });
      return;
    }
    this.#log(`adopting the previous browser instance (port ${stale.port}) for shutdown`);
    if (stale.pid) {
      try {
        process.kill(-stale.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(stale.pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    rmSync(path, { force: true });
  }
}

/** Ask the OS for a free loopback port. */
function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolvePromise(port) : reject(new Error('could not allocate a port'))));
    });
  });
}

/** Terminate a detached child and its process group. */
async function killTree(child) {
  const pid = child.pid;
  if (!pid) return;
  const signalGroup = (signal) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      try {
        child.kill(signal);
        return true;
      } catch {
        return false;
      }
    }
  };
  if (!signalGroup('SIGTERM')) return;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
  signalGroup('SIGKILL');
}

/** Turn user input into a navigable URL. */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return 'about:blank';
  if (/^(about|data|file|https?|blob|chrome):/i.test(raw)) return raw;
  return `https://${raw}`;
}

/** Clamp a requested viewport dimension to something ordinary sites survive. */
function clampViewport(value, min, max, fallback) {
  const n = typeof value === 'number' ? Math.round(value) : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}
