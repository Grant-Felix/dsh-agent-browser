/**
 * Search engines: a pre-configured table, a real probe, and an autonomous pick.
 *
 * The point is that a caller never has to know or type an engine URL. Ask for a
 * query; this module decides where to send it — using a pinned choice, a
 * remembered one, or by actually measuring the candidates and picking the best.
 *
 * Probing is a REAL navigation per candidate, run sequentially in one dedicated
 * page: sequential because parallel navigations share the same browser and would
 * contaminate each other's timings, and a dedicated page because the user's own
 * page should not be hijacked. The probe page is made active, so the Sidebar
 * panel shows the test happening live.
 */
import { join } from 'node:path';
import { stateDir } from './config.js';
import { readJson, writeJson } from './store.js';

export const SEARCH_STORE_FILE = 'search.json';
export const SEARCH_STORE_VERSION = 1;

/**
 * Engines offered out of the box. `{q}` is replaced by the URL-encoded query.
 * The list is deliberately broad: reachability differs a lot by region (a
 * China-based host typically cannot reach Google at all), which is exactly why
 * this project measures instead of assuming.
 */
export const BUILTIN_ENGINES = [
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={q}' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q={q}' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={q}' },
  { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com/search?q={q}' },
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/sp/search?query={q}' },
  { id: 'mojeek', name: 'Mojeek', url: 'https://www.mojeek.com/search?q={q}' },
  { id: 'ecosia', name: 'Ecosia', url: 'https://www.ecosia.org/search?q={q}' },
  { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd={q}' },
  { id: 'sogou', name: '搜狗', url: 'https://www.sogou.com/web?query={q}' },
  { id: 'yandex', name: 'Yandex', url: 'https://yandex.com/search/?text={q}' },
];

/**
 * What one inspected page reports about itself: navigation metrics from the
 * page's own Performance API (comparable across engines) plus the evidence
 * needed to tell a real result page from an interstitial.
 *
 * Three independent signals, because each alone has been fooled in practice:
 * - visible text / title: an interstitial says so ("Captcha - Brave Search",
 *   "此验证码用于确认…", "403 - Forbidden … automated queries")
 * - the URL: engines redirect to dedicated walls (Google `/sorry/index`,
 *   Baidu `wappass`, Sogou `antispider`)
 * - whether the page actually mentions the query: an interstitial normally does
 *   not, and a bare outbound-link count is too weak to tell them apart (the
 *   Sogou anti-spider page has plenty of links and looked "usable")
 * @param query - the query that was searched, embedded as a literal.
 */
export const pageReport = (query) => `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const text = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 6000);
  const lower = text.toLowerCase();
  const title = document.title || '';
  const href = location.href.toLowerCase();
  const wanted = ${JSON.stringify(String(query ?? ''))}.toLowerCase().trim();
  const blockPattern = /captcha|unusual traffic|are you a robot|verify (that )?you are human|access denied|automated queries|403 - forbidden|enable javascript|before you continue|too many requests|unusual activity|please enable cookies|antispider|robot check|请开启javascript|验证码|安全验证|异常流量|请进行验证|网络不给力|人机验证|反爬/i;
  const urlBlock = /\\/sorry|wappass|\\/captcha|antispider|antip=|antispam|antibot|\\/verify|verify\\?|challenge|consent\\.|\\/blocked/i;
  const links = document.querySelectorAll('a[href^="http"]').length;
  const hasQuery = wanted.length >= 2 && (lower.includes(wanted) || title.toLowerCase().includes(wanted));
  return {
    url: location.href,
    title,
    readyState: document.readyState,
    ttfbMs: nav ? Math.round(nav.responseStart) : null,
    loadMs: nav && nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd) : nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    transferBytes: nav ? nav.transferSize : null,
    links,
    hasQuery,
    blocked: blockPattern.test(lower) || blockPattern.test(title.toLowerCase()) || urlBlock.test(href),
    sample: text.replace(/\\s+/g, ' ').slice(0, 200),
  };
})()`;

/**
 * Turn one page report into a verdict.
 * @param report - `pageReport()` output.
 * @returns `{ blocked, usable, status }`.
 */
export function judgeReport(report) {
  const blocked = report?.blocked === true;
  const links = report?.links ?? 0;
  const hasQuery = report?.hasQuery === true;
  const usable = !blocked && links >= 3 && hasQuery;
  return { blocked, usable, status: blocked ? 'blocked' : usable ? 'ok' : links >= 3 && !hasQuery ? 'no-results' : 'thin' };
}

/** Where the search state lives. */
export function defaultSearchStorePath() {
  return join(stateDir(), SEARCH_STORE_FILE);
}

/** Merge configured custom engines over the built-in table. */
export function resolveEngines(config) {
  const engines = new Map(BUILTIN_ENGINES.map((engine) => [engine.id, { ...engine }]));
  const custom = Array.isArray(config?.searchEngines) ? config.searchEngines : [];
  for (const entry of custom) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!id || !url.includes('{q}')) continue;
    engines.set(id, { id, name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id, url });
  }
  return [...engines.values()];
}

/** Build one engine's search URL for a query. */
export function buildSearchUrl(engine, query) {
  return engine.url.replace('{q}', encodeURIComponent(String(query ?? '').trim()));
}

/**
 * Owns the engine table, the remembered choice, and the probe.
 */
export class SearchService {
  #browser;
  #config;
  #log;
  #storePath;
  #state;

  constructor({ browser, config, log, storePath }) {
    this.#browser = browser;
    this.#config = config;
    this.#log = typeof log === 'function' ? log : () => {};
    this.#storePath = storePath ?? defaultSearchStorePath();
    this.#state = this.#read();
  }

  #read() {
    const stored = readJson(this.#storePath, null);
    const empty = { version: SEARCH_STORE_VERSION, selected: null, probedAt: null, probes: [], history: [] };
    if (!stored || stored.version !== SEARCH_STORE_VERSION) return empty;
    return {
      version: SEARCH_STORE_VERSION,
      selected: typeof stored.selected === 'string' ? stored.selected : null,
      probedAt: typeof stored.probedAt === 'string' ? stored.probedAt : null,
      probes: Array.isArray(stored.probes) ? stored.probes : [],
      history: Array.isArray(stored.history) ? stored.history.slice(-20) : [],
    };
  }

  #persist() {
    return writeJson(this.#storePath, this.#state);
  }

  /** Every engine this host offers, with the active one marked. */
  list() {
    const pinned = typeof this.#config.searchEngine === 'string' ? this.#config.searchEngine.trim() : '';
    const active = this.activeId();
    return resolveEngines(this.#config).map((engine) => ({
      id: engine.id,
      name: engine.name,
      url: engine.url,
      active: engine.id === active,
      pinned: pinned !== '' && engine.id === pinned,
      lastProbe: this.#state.probes.find((probe) => probe.id === engine.id) ?? null,
    }));
  }

  /** The engine a query would go to right now, or null when nothing is chosen. */
  activeId() {
    const pinned = typeof this.#config.searchEngine === 'string' ? this.#config.searchEngine.trim() : '';
    if (pinned !== '') return pinned;
    const ttlHours = Number(this.#config.searchSelectionTtlHours) || 0;
    if (this.#state.selected && ttlHours > 0 && this.#state.probedAt) {
      const age = Date.now() - Date.parse(this.#state.probedAt);
      if (Number.isFinite(age) && age < ttlHours * 3600_000) return this.#state.selected;
    }
    return this.#state.selected && ttlHours <= 0 ? this.#state.selected : null;
  }

  /** The remembered state, for the tool's report. */
  snapshot() {
    return {
      selected: this.#state.selected,
      active: this.activeId(),
      probedAt: this.#state.probedAt,
      probes: this.#state.probes,
    };
  }

  /** Resolve an engine by id or throw with the known ids. */
  requireEngine(id) {
    const engines = resolveEngines(this.#config);
    const engine = engines.find((candidate) => candidate.id === id);
    if (!engine) {
      throw new Error(`unknown search engine "${id}" (known: ${engines.map((e) => e.id).join(', ')})`);
    }
    return engine;
  }

  /**
   * Send a query to an engine without anyone having to type an engine URL.
   * @param query - what to search for.
   * @param engineId - force one engine; omit to use the active choice.
   * @returns the engine used, the URL, and the resulting status.
   */
  async search(query, engineId) {
    const text = String(query ?? '').trim();
    if (text === '') throw new Error('a search needs a non-empty query');
    const candidates = await this.#candidatesFor(engineId);
    if (candidates.length === 0) throw new Error('no search engine could be reached to choose from');

    const maxAttempts = Math.max(1, Number(this.#config.searchMaxAttempts) || 3);
    const attempts = [];
    let status = null;
    for (const engine of candidates.slice(0, maxAttempts)) {
      const url = buildSearchUrl(engine, text);
      status = await this.#browser.navigate(url);
      let report = null;
      try {
        report = await this.#browser.evaluate(pageReport(text));
      } catch {
        report = null;
      }
      // Verifying the RESULT, not just the choice: a measured-fast engine can
      // still answer one query with a captcha (observed with Baidu: it served
      // `wikipedia` fine and challenged `deepseek harness`; Sogou answered
      // `wikipedia` and sent this very query to /antispider).
      const { blocked, usable, status: verdictStatus } = judgeReport(report);
      const verdict = {
        id: engine.id,
        name: engine.name,
        url,
        blocked,
        links: report?.links ?? 0,
        hasQuery: report?.hasQuery === true,
        status: verdictStatus,
      };
      attempts.push(verdict);
      if (usable) {
        this.#state.selected = engine.id;
        this.#state.history = [...this.#state.history, { at: new Date().toISOString(), engine: engine.id, query: text, url }].slice(-20);
        this.#persist();
        return { engine: { id: engine.id, name: engine.name }, url, query: text, attempts, blocked: false, status };
      }
      this.#log(`search via ${engine.id} came back ${verdict.status}; trying the next candidate`);
    }

    // Say it plainly instead of presenting a captcha page as a result page.
    const last = attempts[attempts.length - 1];
    this.#persist();
    return {
      engine: last ? { id: last.id, name: last.name } : null,
      url: last?.url ?? null,
      query: text,
      attempts,
      blocked: true,
      note:
        'every attempted engine answered with a block or interstitial page (captcha / unusual-traffic / consent). ' +
        'Run action=probe to re-measure, try action=search with an explicit engine, or complete the check in the Sidebar panel.',
      status,
    };
  }

  /**
   * Which engines a search may try, best first: the pinned/measured choice, then
   * every usable candidate from the last probe. With no data at all it probes.
   */
  async #candidatesFor(engineId) {
    if (engineId) return [this.requireEngine(engineId)];
    const ordered = [];
    const push = (id) => {
      if (!id || ordered.some((engine) => engine.id === id)) return;
      try {
        ordered.push(this.requireEngine(id));
      } catch {
        // The engine is no longer configured; skip it.
      }
    };
    push(this.activeId());
    for (const probe of this.#rankedProbes()) push(probe.id);
    if (ordered.length === 0) {
      const probe = await this.probe({ select: true });
      for (const entry of probe.ranking.filter((entry) => entry.usable)) push(entry.id);
    }
    return ordered;
  }

  /** Last probe's results, usable first, then by measured speed. */
  #rankedProbes() {
    return [...this.#state.probes].sort((a, b) => {
      if ((a.usable === true) !== (b.usable === true)) return a.usable ? -1 : 1;
      const aSpeed = a.loadMs ?? a.wallMs ?? Number.MAX_SAFE_INTEGER;
      const bSpeed = b.loadMs ?? b.wallMs ?? Number.MAX_SAFE_INTEGER;
      return aSpeed - bSpeed;
    });
  }

  /**
   * Measure the candidate engines for real and rank them.
   *
   * Each candidate is a full navigation in one dedicated page; `usable` combines
   * reachability with an interstitial check (a captcha or consent wall is not a
   * working search engine even when it loads fast).
   * @param options - `engines` (subset), `query`, `timeoutMs`, `select` (persist the winner).
   * @returns the per-engine table plus the ranking.
   */
  async probe(options = {}) {
    const list = resolveEngines(this.#config);
    const wanted = Array.isArray(options.engines) && options.engines.length > 0
      ? options.engines.map((id) => this.requireEngine(id))
      : list;
    const query = String(options.query ?? this.#config.searchProbeQuery ?? 'wikipedia').trim() || 'wikipedia';
    const timeoutMs = Number(options.timeoutMs) || Number(this.#config.searchProbeTimeoutMs) || 8000;

    const previousActive = this.#browser.status().activeKey;
    const results = [];
    let probePageKey = null;
    for (const [index, engine] of wanted.entries()) {
      const url = buildSearchUrl(engine, query);
      const startedAt = Date.now();
      const entry = { id: engine.id, name: engine.name, url, ok: false, status: 'error', wallMs: null, ttfbMs: null, loadMs: null, links: null, blocked: null, title: '', sample: '' };
      try {
        // First engine opens the probe page (which becomes active, so the panel
        // watches the test); the rest simply navigate that same page.
        if (index === 0) {
          await this.#browser.navigate(url, { newPage: true, settleMs: timeoutMs });
          probePageKey = this.#browser.status().activeKey;
        } else {
          await this.#browser.navigate(url, { settleMs: timeoutMs });
        }
        entry.wallMs = Date.now() - startedAt;
        const report = await this.#browser.evaluate(pageReport(query));
        if (report && typeof report === 'object') {
          entry.ttfbMs = report.ttfbMs ?? null;
          entry.loadMs = report.loadMs ?? null;
          entry.links = report.links ?? null;
          entry.hasQuery = report.hasQuery === true;
          entry.blocked = report.blocked === true;
          entry.title = report.title ?? '';
          entry.sample = report.sample ?? '';
          entry.finalUrl = report.url ?? url;
        }
        const verdict = judgeReport(report);
        entry.usable = verdict.usable;
        entry.ok = true;
        entry.status = verdict.status;
      } catch (error) {
        entry.wallMs = Date.now() - startedAt;
        entry.status = 'error';
        entry.error = String(error?.message ?? error).slice(0, 200);
        entry.usable = false;
      }
      results.push(entry);
      this.#log(`probe ${engine.id}: ${entry.status} wall=${entry.wallMs}ms ttfb=${entry.ttfbMs} links=${entry.links}`);
    }

    // Leave the user's browsing where it was: the probe page was a means, not a result.
    if (probePageKey) {
      try {
        await this.#browser.closePage(probePageKey);
      } catch {
        // Already gone.
      }
    }
    if (previousActive && previousActive !== probePageKey) {
      try {
        await this.#browser.activatePage(previousActive);
      } catch {
        // The previous page may have been parked meanwhile.
      }
    }

    const ranking = [...results].sort((a, b) => {
      if (a.usable !== b.usable) return a.usable ? -1 : 1;
      const aSpeed = a.loadMs ?? a.wallMs ?? Number.MAX_SAFE_INTEGER;
      const bSpeed = b.loadMs ?? b.wallMs ?? Number.MAX_SAFE_INTEGER;
      if (aSpeed !== bSpeed) return aSpeed - bSpeed;
      return (b.links ?? 0) - (a.links ?? 0);
    });

    this.#state.probes = results;
    this.#state.probedAt = new Date().toISOString();
    const winner = ranking.find((entry) => entry.usable);
    const pinned = typeof this.#config.searchEngine === 'string' ? this.#config.searchEngine.trim() : '';
    if (options.select !== false && winner && pinned === '') {
      this.#state.selected = winner.id;
      this.#log(`probe picked ${winner.id} (${winner.loadMs ?? winner.wallMs}ms, ${winner.links} links)`);
    }
    this.#persist();
    return {
      query,
      probedAt: this.#state.probedAt,
      selected: this.#state.selected,
      pinned: pinned === '' ? null : pinned,
      ranking,
      recommendation: winner
        ? { id: winner.id, name: winner.name, why: `${winner.loadMs ?? winner.wallMs} ms load, ${winner.links} links, not blocked` }
        : null,
    };
  }
}
