/**
 * Configuration defaults, path resolution, and small pure helpers.
 *
 * This module is deliberately DSH-free (Node builtins only) so the runtime can
 * be exercised outside the harness.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package directory (this file lives in `<pkg>/src/`). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every tunable, with the value an empty config row resolves to. */
export const DEFAULTS = Object.freeze({
  /** Chrome/Chromium binary. Empty = resolve Chrome-Linux, then data dirs, then PATH. */
  chromePath: '',
  /**
   * Which engine to drive. `'auto'` prefers Chromium and falls back to Firefox.
   * Firefox 157 speaks WebDriver BiDi only — it exposes no CDP at all.
   */
  browser: 'auto',
  /** Firefox binary. Empty = the vendored build, then PATH. */
  firefoxPath: '',

  /**
   * The virtual screen used while no panel has reported its own size.
   *
   * An offscreen browser has no screen of its own, and a 0x0 viewport renders
   * nothing at all (measured: frames 0, clicks land nowhere). The Sidebar's
   * measured box overrides this the moment it connects; this is only what the
   * agent gets before that, so it is a work surface, not an assumption about the
   * user's display.
   */
  virtualScreenWidth: 1280,
  virtualScreenHeight: 900,
  /** Profile directory. Empty = `~/.local/share/dsh-agent-browser/profile`. */
  userDataDir: '',
  /** First URL opened by the lazily started browser. */
  startUrl: 'about:blank',
  /**
   * Fixed viewport override. `0` means AUTO and is the default: this project
   * does NOT assume a screen size, because users run very different displays and
   * Sidebar widths. The size has exactly one real source — the panel measuring
   * its own column — and until the panel reports one, no override is applied at
   * all and the engine's own default stands. Set both to a number only when you
   * want a page pinned to a size even with no panel on screen.
   */
  viewportWidth: 0,
  viewportHeight: 0,
  /** Let the panel's measured size drive the viewport (the normal mode). */
  viewportFollowsPanel: true,
  /**
   * Safety rails, not preferences: they only reject absurd requested sizes.
   * They exist because a 40 px or 40000 px viewport breaks any ordinary page,
   * not because this project has an opinion about your screen.
   */
  viewportMinWidth: 320,
  viewportMinHeight: 240,
  viewportMaxWidth: 10000,
  viewportMaxHeight: 10000,
  /** Upper bound on frames relayed to the panel, frames per second. */
  /**
   * Naturalize input: curved jittered pointer paths, press dwell, per-character
   * typing cadence and wheel ticks. Behavior-scored systems evaluate the session,
   * and a teleporting cursor is the cheapest thing to detect.
   */
  humanizeInput: true,
  /** Where downloads land. Empty = `<state dir>/downloads`. */
  downloadDir: '',
  /**
   * Firefox-only parity fix, and an ACTIVE OVERRIDE — read this before flipping it.
   *
   * Firefox reports `navigator.webdriver === true` as soon as its Remote Agent is
   * on, and measurement on this build shows no preference can change that any
   * more (`dom.webdriver.enabled` and `marionette.enabled` were both tested, alone
   * and together: still true). Chromium never reports it here, because this
   * project simply does not pass `--enable-automation`.
   *
   * With this on, a WebDriver BiDi `script.addPreloadScript` redefines the
   * property to false in every document. That is not a configuration switch — it
   * is the browser being told to misreport a fact — so it is named as an override
   * and can be turned off to let Firefox identify itself.
   */
  hideWebdriver: true,
  /** 'human' plans hand-like paths; 'linear' teleports (kept for A/B tests). */
  pointerModel: 'human',
  /** Cruise speed for a planned path; duration follows distance / speed. */
  pointerSpeedPxPerSec: 900,
  /** Tremor amplitude (0 = none, 1 = default, higher = shakier). */
  pointerJitter: 1,
  /** Typing: base gap between characters and how much it varies. */
  typingIntervalMs: 90,
  typingJitterMs: 70,
  /** How long a press is held before release. */
  pressDwellMs: 60,
  fps: 12,
  /** Screencast/capture JPEG quality (10-100). */
  jpegQuality: 60,
  /** Longest edge of a relayed frame, in device pixels. */
  maxWidth: 1600,
  /** Extra Chrome argv appended verbatim (control-plane flags are rejected). */
  extraArgs: [],
  /**
   * Park a page (close its target, remember the URL) after this many minutes
   * without a command touching it. A closed page frees ~245 MB once Chromium
   * reaps the renderer (measured: reclaim lands ~20 s later, not instantly).
   * 0 disables page parking.
   */
  pageIdleTimeoutMin: 180,
  /**
   * Stop the whole browser process after this many minutes without any command.
   * This is the big win: a full stop releases ~1.4-2 GB immediately, and the
   * remembered pages come back on the next call.
   */
  browserIdleTimeoutMin: 360,
  /** Reopen the remembered active page when the browser cold-starts. */
  restoreOnDemand: true,
  /** Cap on simultaneously live pages; the least recently used is parked past it. 0 = unlimited. */
  maxLivePages: 8,
  /** How often the lifecycle sweep runs, in seconds. */
  sweepIntervalSec: 60,
  /**
   * Pin one search engine by id (e.g. `bing`). Empty = let this project measure
   * the candidates and choose; a pin is for operators who know their network.
   */
  searchEngine: '',
  /** Extra engines: `[{ id, name, url }]`, where `url` contains `{q}`. */
  searchEngines: [],
  /** Query used when measuring engines; any common word works. */
  searchProbeQuery: 'wikipedia',
  /** Per-candidate navigation budget during a probe, in milliseconds. */
  searchProbeTimeoutMs: 8000,
  /** How long a measured choice stays fresh, in hours; 0 = never expire. */
  searchSelectionTtlHours: 24,
  /** How many usable candidates one search may try before reporting a block. */
  searchMaxAttempts: 3,
});

/** Flags a config MUST NOT inject: they own the control plane this plugin manages. */
const BLOCKED_ARGS = new Set([
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--user-data-dir',
  '--headless',
  '--headless=new',
  '--headless=old',
  '--no-startup-window',
  '--enable-automation',
]);

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Clamp a possibly fractional number (tremor amplitude is not an integer). */
function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1 || value === 'yes' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 0 || value === 'no' || value === 'off') return false;
  return fallback;
}

/**
 * The one and only display mode: HEADED, with the Sidebar panel as the head.
 *
 * There is no headless mode and no desktop-window mode in this plugin. The panel
 * is the browser's head — it supplies the screen (its own measured box) and it
 * receives the input — so the engine renders offscreen and the panel shows it.
 * Chromium reaches that state with `--ozone-platform=headless`, which measurement
 * shows is strictly more authentic than the `--headless` flag:
 *
 *   | signal          | --headless=new         | --ozone-platform=headless |
 *   | User-Agent      | HeadlessChrome         | Chrome                    |
 *   | WebGL renderer  | SwiftShader (software) | the real GPU (Intel/Mesa) |
 *   | detector rows   | 4 of 58 failed         | 0 of 58 failed            |
 *
 * The flag name is an engine implementation detail; it is not the plugin's mode.
 * @returns `{ mode, headed, desktopWindow, reason }`.
 */
export function resolveDisplayMode() {
  return {
    mode: 'sidebar-headed',
    headed: true,
    desktopWindow: false,
    reason:
      'headed, with the Sidebar panel as the head: the panel supplies the screen and receives the input, so no desktop window is ever opened',
  };
}

/**
 * Drop control-plane flags from a user-supplied argv, keeping every other token
 * in order. A `--flag value` pair whose flag is blocked drops both tokens.
 * @param raw - the configured extra argv.
 * @returns the accepted tokens.
 */
export function filterExtraArgs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const token of raw) {
    if (typeof token !== 'string' || token === '') continue;
    const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (BLOCKED_ARGS.has(flag) || BLOCKED_ARGS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/** Normalize a raw config row into the concrete values the runtime uses. */
export function resolveConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    chromePath: asString(src.chromePath).trim(),
    browser: ['chromium', 'firefox'].includes(src.browser) ? src.browser : 'auto',
    firefoxPath: asString(src.firefoxPath).trim(),
    virtualScreenWidth: clampInt(src.virtualScreenWidth, 200, 10000, DEFAULTS.virtualScreenWidth),
    virtualScreenHeight: clampInt(src.virtualScreenHeight, 200, 10000, DEFAULTS.virtualScreenHeight),
    userDataDir: asString(src.userDataDir).trim(),
    startUrl: asString(src.startUrl, DEFAULTS.startUrl) || DEFAULTS.startUrl,
    // 0 = auto (no override). A non-zero value is still clamped to the rails.
    viewportWidth: clampInt(src.viewportWidth, 0, DEFAULTS.viewportMaxWidth, DEFAULTS.viewportWidth),
    viewportHeight: clampInt(src.viewportHeight, 0, DEFAULTS.viewportMaxHeight, DEFAULTS.viewportHeight),
    viewportFollowsPanel: asBoolean(src.viewportFollowsPanel, DEFAULTS.viewportFollowsPanel),
    viewportMinWidth: clampInt(src.viewportMinWidth, 1, 10000, DEFAULTS.viewportMinWidth),
    viewportMinHeight: clampInt(src.viewportMinHeight, 1, 10000, DEFAULTS.viewportMinHeight),
    viewportMaxWidth: clampInt(src.viewportMaxWidth, 1, 100000, DEFAULTS.viewportMaxWidth),
    viewportMaxHeight: clampInt(src.viewportMaxHeight, 1, 100000, DEFAULTS.viewportMaxHeight),
    humanizeInput: asBoolean(src.humanizeInput, DEFAULTS.humanizeInput),
    downloadDir: asString(src.downloadDir, DEFAULTS.downloadDir).trim(),
    hideWebdriver: asBoolean(src.hideWebdriver, DEFAULTS.hideWebdriver),
    pointerModel: src.pointerModel === 'linear' ? 'linear' : 'human',
    pointerSpeedPxPerSec: clampInt(src.pointerSpeedPxPerSec, 60, 6000, DEFAULTS.pointerSpeedPxPerSec),
    pointerJitter: clampNumber(src.pointerJitter, 0, 5, DEFAULTS.pointerJitter),
    typingIntervalMs: clampInt(src.typingIntervalMs, 5, 2000, DEFAULTS.typingIntervalMs),
    typingJitterMs: clampInt(src.typingJitterMs, 0, 2000, DEFAULTS.typingJitterMs),
    pressDwellMs: clampInt(src.pressDwellMs, 0, 1000, DEFAULTS.pressDwellMs),
    fps: clampInt(src.fps, 1, 30, DEFAULTS.fps),
    jpegQuality: clampInt(src.jpegQuality, 10, 100, DEFAULTS.jpegQuality),
    maxWidth: clampInt(src.maxWidth, 320, 4096, DEFAULTS.maxWidth),
    extraArgs: filterExtraArgs(src.extraArgs),
    pageIdleTimeoutMin: clampInt(src.pageIdleTimeoutMin, 0, 7 * 24 * 60, DEFAULTS.pageIdleTimeoutMin),
    browserIdleTimeoutMin: clampInt(src.browserIdleTimeoutMin, 0, 7 * 24 * 60, DEFAULTS.browserIdleTimeoutMin),
    restoreOnDemand: asBoolean(src.restoreOnDemand, DEFAULTS.restoreOnDemand),
    maxLivePages: clampInt(src.maxLivePages, 0, 64, DEFAULTS.maxLivePages),
    sweepIntervalSec: clampInt(src.sweepIntervalSec, 5, 3600, DEFAULTS.sweepIntervalSec),
    searchEngine: asString(src.searchEngine).trim(),
    searchEngines: Array.isArray(src.searchEngines) ? src.searchEngines : DEFAULTS.searchEngines,
    searchProbeQuery: asString(src.searchProbeQuery, DEFAULTS.searchProbeQuery) || DEFAULTS.searchProbeQuery,
    searchProbeTimeoutMs: clampInt(src.searchProbeTimeoutMs, 500, 120_000, DEFAULTS.searchProbeTimeoutMs),
    searchSelectionTtlHours: clampInt(src.searchSelectionTtlHours, 0, 24 * 365, DEFAULTS.searchSelectionTtlHours),
    searchMaxAttempts: clampInt(src.searchMaxAttempts, 1, 10, DEFAULTS.searchMaxAttempts),
  };
}

/** The default on-disk profile, kept out of the package tree. */
export function defaultUserDataDir() {
  return join(homedir(), '.local', 'share', 'dsh-agent-browser', 'profile');
}

/** Where the plugin keeps its own state (pid/port lock), beside the profile. */
export function stateDir() {
  return join(homedir(), '.local', 'share', 'dsh-agent-browser');
}

/** The profile directory this config resolves to. */
export function resolveUserDataDir(config, engine = 'chromium') {
  const configured = asString(config?.userDataDir).trim();
  if (configured) return isAbsolute(configured) ? configured : resolve(configured);
  // One directory per engine. They used to share `profile/`, which put Chromium's
  // `Default/` tree and Firefox's `prefs.js`/`places.sqlite` in the same place —
  // two incompatible layouts, and a switch of engine would hand Firefox a
  // Chromium profile (or the reverse). Chromium keeps the old name so existing
  // logins survive.
  return engine === 'firefox' ? join(stateDir(), 'profile-firefox') : defaultUserDataDir();
}

/** Locate one executable on PATH. */
export function whichSync(binary) {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // A directory we cannot stat is not a hit; keep looking.
    }
  }
  return undefined;
}

/** Every Chrome-Linux location this project considers, most specific first. */
export function chromeCandidates(config) {
  const out = [];
  const configured = asString(config?.chromePath).trim();
  if (configured) out.push(isAbsolute(configured) ? configured : resolve(configured));
  if (process.env.DSH_AGENT_BROWSER_CHROME) out.push(process.env.DSH_AGENT_BROWSER_CHROME);
  // The vendored base of this project: <pkg>/vendor/chrome-linux/chrome
  out.push(join(PACKAGE_ROOT, 'vendor', 'chrome-linux', 'chrome'));
  // A copy installed into the data dir (what scripts/vendor-chrome.sh writes).
  out.push(join(stateDir(), 'chromium', 'chrome'));
  out.push(join(homedir(), '.local', 'share', 'dsh-agent-browser', 'chromium', 'chrome'));
  return out;
}

/**
 * Resolve the browser binary.
 * @returns the absolute path, or `undefined` when nothing usable was found.
 */
export function resolveChromePath(config) {
  for (const candidate of chromeCandidates(config)) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      // Unreadable candidate: keep looking.
    }
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    const found = whichSync(name);
    if (found) return found;
  }
  return undefined;
}

/**
 * Resolve the Firefox binary: the vendored build first (this project ships one),
 * then PATH.
 * @returns the absolute path, or `undefined` when nothing usable was found.
 */
export function resolveFirefoxPath(config) {
  const candidates = [
    config?.firefoxPath,
    join(PACKAGE_ROOT, 'vendor', 'firefox', 'firefox', 'firefox'),
    join(stateDir(), 'firefox', 'firefox'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      // Unreadable candidate: keep looking.
    }
  }
  for (const name of ['firefox', 'firefox-esr', 'firefox-bin']) {
    const found = whichSync(name);
    if (found) return found;
  }
  return undefined;
}

/** A short, non-identifying description of what the runtime resolved. */
export function describeResolution(config) {
  const chromePath = resolveChromePath(config);
  return {
    browser: config?.browser ?? 'auto',
    chromePath: chromePath ?? null,
    firefoxPath: resolveFirefoxPath(config) ?? null,
    userDataDir: resolveUserDataDir(config),
    mode: resolveDisplayMode().mode,
  };
}
