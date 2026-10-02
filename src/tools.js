/**
 * The agent-facing tool.
 *
 * One tool carries the browser operations, the same ones the Sidebar panel
 * issues through `/api/agent-browser/command` — an operation is implemented
 * once in the runtime and reached by both callers.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runCommand } from './routes.js';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    text: { type: 'string' },
    // Set by action=screenshot when the attachment service accepted the bytes:
    // an ImageAttachmentRef, so the model can actually SEE the page.
    image: { type: 'object', additionalProperties: true },
  },
};

/**
 * Render the model-facing content of one tool result.
 *
 * A plain result becomes one text block; a result carrying an attachment
 * reference also emits an `image` block, which is what turns a screenshot into
 * something the model can look at instead of a byte count.
 */
function renderText(_args, value) {
  const text = value && typeof value === 'object' && typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2);
  if (value && typeof value === 'object' && value.image && typeof value.image === 'object') {
    return [
      { type: 'text', text },
      { type: 'image', attachment: value.image },
    ];
  }
  return [{ type: 'text', text }];
}

/** A one-line status line. */
function statusLine(status) {
  if (status.state !== 'running') {
    const remembered = (status.pages ?? []).filter((page) => page.state === 'parked').length;
    // Say which mode it will start in: a stopped browser still has a decided
    // headless/headed setting, and leaving it out made the caller guess.
    // One mode only: headed, with the Sidebar panel as the head.
    return `browser: ${status.state} (${status.engine ?? 'engine?'}, ${status.mode ?? 'sidebar-headed'})${status.failure ? ` — ${status.failure}` : ''}${remembered > 0 ? ` | ${remembered} page(s) remembered on disk, restored on the next call` : ''}`;
  }
  const title = status.title ? `"${status.title}"` : '(untitled)';
  const live = (status.pages ?? []).filter((page) => page.state === 'live').length;
  const parked = (status.pages ?? []).filter((page) => page.state === 'parked').length;
  const mode = status.mode ?? 'sidebar-headed';
  return `browser: running | ${mode} | ${status.url} | ${title} | ${status.viewport.width}x${status.viewport.height} | pid ${status.pid} | ${live} live / ${parked} parked page(s)`;
}

/** A compact one-line description of one page entry. */
function pageLine(page) {
  const marks = [page.state, page.active ? 'active' : null].filter(Boolean).join('/');
  const idleMin = Math.round((page.idleMs ?? 0) / 60_000);
  return `  ${page.key} [${marks}] ${idleMin}m idle  ${page.title || '(untitled)'} — ${page.url}`;
}

/** A compact, model-readable page digest. */
function digest(page) {
  const lines = [];
  lines.push(`url: ${page.url}`);
  lines.push(`title: ${page.title}`);
  lines.push(`readyState: ${page.readyState}`);
  if (page.humanCheck?.detected) {
    lines.push(
      '⚠ HUMAN VERIFICATION DETECTED — this page is a challenge/interstitial, not content. ' +
        'Ask the user to finish it in the DSH right-Sidebar panel (the live picture is theirs to operate), then continue. ' +
        `Evidence: ${page.humanCheck.hint || page.humanCheck.title || page.humanCheck.url}`,
    );
  }
  const interactive = Array.isArray(page.interactive) ? page.interactive : [];
  if (interactive.length > 0) {
    lines.push(`interactive elements (${interactive.length}):`);
    for (const [index, item] of interactive.entries()) {
      const label = item.label ? ` "${item.label}"` : '';
      const href = item.href ? ` -> ${item.href}` : '';
      lines.push(`  [${index}] <${item.tag}${item.type ? ` type=${item.type}` : ''}>${label} at (${item.x},${item.y})${href}`);
    }
  }
  if (page.text) {
    lines.push('text:');
    lines.push(String(page.text).slice(0, 8000));
  }
  return lines.join('\n');
}

/**
 * One line per engine, for the model to read.
 * @param engines - `search.list()` output.
 */
function engineLines(engines) {
  return engines.map((engine) => {
    const marks = [engine.active ? 'active' : null, engine.pinned ? 'pinned' : null].filter(Boolean).join('/');
    const probe = engine.lastProbe;
    const measured = probe
      ? `${probe.usable ? 'usable' : probe.status} ${probe.loadMs ?? probe.wallMs}ms ${probe.links ?? 0} links`
      : 'not probed yet';
    return `  ${engine.id.padEnd(12)} ${marks ? `[${marks}] ` : ''}${engine.name} — ${measured}`;
  });
}

/** Describe a point the way the caller gave it, for readable results. */
function describePoint(args, prefix = '') {
  const x = args[`${prefix}x`];
  const y = args[`${prefix}y`];
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) return `(${x},${y})`;
  const nx = args[`${prefix}nx`];
  const ny = args[`${prefix}ny`];
  if (Number.isFinite(Number(nx)) && Number.isFinite(Number(ny))) return `(${nx},${ny} of the viewport)`;
  return 'the current pointer position';
}

/** A one-line verdict for one probed engine. */
function probeLine(entry) {
  return (
    `  ${entry.usable ? 'usable  ' : 'unusable'} ${String(entry.id).padEnd(12)} ${String(entry.status).padEnd(8)} ` +
    `wall=${String(entry.wallMs).padStart(5)}ms ttfb=${String(entry.ttfbMs).padStart(5)} links=${String(entry.links).padStart(3)} ${String(entry.title ?? '').slice(0, 40)}`
  );
}

/**
 * Register the browser tool.
 * @param ctx - the plugin context.
 * @param browser - the runtime.
 * @param search - the search service (engine table, probe, autonomous pick).
 * @returns the disposer.
 */
export function registerTools(ctx, browser, search) {
  // The attachment service owns image bytes; when it is absent the screenshot
  // action degrades to a byte count instead of failing.
  const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
  return ctx.tools.register(
    defineTool({
      name: 'agent_browser',
      description:
        'Drive the shared agent browser (a real Chromium managed by this plugin, also visible and takeable-over live in the DSH right Sidebar). ' +
        'Actions: status (is it running, what pages exist), open (navigate the current page, or open a new one with newPage), read (page url/title/text plus the interactive elements with their viewport coordinates), ' +
        'eval (run JavaScript in the page and return the JSON value), back/forward/reload, screenshot (base64 PNG), pages (list every page with its idle time), ' +
        'close (you are done with this page: it is parked — target closed, URL kept), restore (bring a parked page back), activate (focus a page by key or URL; a parked one is reopened), sweep (run the reclaim policy now), , forget (close AND drop the record — the destructive counterpart of parking)' +
        'viewport (resize the page to width x height CSS pixels; the Sidebar panel otherwise keeps the viewport matched to its own column), stop (shut the browser down). ' +
        'Acting: click (x,y in CSS px, or nx,ny as 0..1 of the viewport; add double for a double click), move, drag (x,y -> toX,toY: press, travel a hand-like path, release — this is the motion slider CAPTCHAs ask for), scroll (deltaX,deltaY at x,y or the viewport centre), type (text, optionally selector to focus first and submit to press Enter), key (key name plus optional modifiers). ' +
        'read returns interactive elements WITH their viewport pixel coordinates, so click uses those numbers directly; the pointer is moved along a human-like path (curved, minimum-jerk speed, configurable tremor) rather than teleporting. ' +
        'Searching: search (a query; the engine is chosen FOR you — never type an engine URL yourself), engines (the pre-configured table plus the current choice and each engine\'s last measurement), ' +
        'probe (really test the engines and rank them by reachability, load time and result density; it then selects the best one). ' +
        'Reachability differs a lot by network and changes over time (a captcha wall or an "unusual traffic" page loads fast and is NOT usable), so when a search comes back blocked, or you have no idea which engine works here, run probe first and let it choose. ' +
        'Lifecycle: an idle page is parked after pageIdleTimeoutMin, and the whole browser is stopped after browserIdleTimeoutMin without any call; every page URL is remembered on disk, ' +
        'so the next call after a stop reopens the page automatically (reopening measured at ~32 ms plus a normal page load). ' +
        'Prefer read over eval for ordinary page inspection. The browser is shared by every session in this profile and keeps its profile on disk, so logins survive restarts.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: [
            'status',
            'open',
            'read',
            'eval',
            'back',
            'forward',
            'reload',
            'screenshot',
            'pages',
            'close',
            'restore',
            'activate',
            'forget',
            'sweep',
            'viewport',
            'click',
            'move',
            'drag',
            'scroll',
            'type',
            'key',
            'search',
            'engines',
            'probe',
            'import_logins',
            'cookies',
            'downloads',
            'stop',
          ],
          description: 'Which browser operation to run.',
        },
        x: {
          type: 'number',
          description: 'Target X in CSS pixels for click/move/drag/scroll (the numbers read returns).',
        },
        y: {
          type: 'number',
          description: 'Target Y in CSS pixels for click/move/drag/scroll.',
        },
        nx: {
          type: 'number',
          description: 'Target X as a 0..1 ratio of the viewport, used when x is omitted.',
        },
        ny: {
          type: 'number',
          description: 'Target Y as a 0..1 ratio of the viewport, used when y is omitted.',
        },
        toX: {
          type: 'number',
          description: 'Drop-point X in CSS pixels for action=drag.',
        },
        toY: {
          type: 'number',
          description: 'Drop-point Y in CSS pixels for action=drag.',
        },
        toNx: {
          type: 'number',
          description: 'Drop-point X as a 0..1 ratio of the viewport, used when toX is omitted.',
        },
        toNy: {
          type: 'number',
          description: 'Drop-point Y as a 0..1 ratio of the viewport, used when toY is omitted.',
        },
        double: {
          type: 'boolean',
          description: 'For action=click: click twice (double click).',
        },
        noImage: {
          type: 'boolean',
          description: 'For action=screenshot: skip attaching the image and report only the byte count (saves context).',
        },
        text: {
          type: 'string',
          description: 'What to type for action=type.',
        },
        selector: {
          type: 'string',
          description: 'For action=type: a CSS selector to focus (and select) before typing.',
        },
        submit: {
          type: 'boolean',
          description: 'For action=type: press Enter after typing.',
        },
        key: {
          type: 'string',
          description: 'Key name for action=key, e.g. Enter, Tab, Escape, Backspace, ArrowDown, PageDown, Space.',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'For action=key: modifier names to hold, e.g. ["Control"] or ["Shift"].',
        },
        deltaX: {
          type: 'number',
          description: 'Horizontal wheel delta for action=scroll.',
        },
        deltaY: {
          type: 'number',
          description: 'Vertical wheel delta for action=scroll (positive scrolls down).',
        },
        source: {
          type: 'string',
          description:
            'For action=import_logins: a substring of the cookie store to use, e.g. "helium". Omit to consider them all (see the source list first).',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'For action=import_logins / action=cookies: limit to these domain suffixes, e.g. ["github.com"].',
        },
        dryRun: {
          type: 'boolean',
          description: 'For action=import_logins: report what WOULD be copied without copying anything (default true — pass false to actually import).',
        },
        domain: {
          type: 'string',
          description: 'For action=cookies: only report cookies whose domain contains this string.',
        },
        query: {
          type: 'string',
          description: 'What to search for, for action=search (and the probe query for action=probe). Never a URL.',
        },
        engine: {
          type: 'string',
          description: 'Force one search engine by id for action=search; omit to use the measured/remembered choice.',
        },
        engines: {
          type: 'array',
          items: { type: 'string' },
          description: 'Engine ids to restrict action=probe to. Omit to test the whole pre-configured table.',
        },
        select: {
          type: 'boolean',
          description: 'For action=probe: whether the winner becomes the active engine (default true).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Per-engine navigation budget for action=probe, in milliseconds (default 8000).',
        },
        url: {
          type: 'string',
          description: 'Target URL for action=open. A bare host is completed to https://.',
        },
        expression: {
          type: 'string',
          description: 'JavaScript expression for action=eval. Evaluated in the page; the JSON value is returned.',
        },
        width: {
          type: 'number',
          description: 'Viewport width for action=viewport, in CSS pixels (clamped to 360-3840).',
        },
        height: {
          type: 'number',
          description: 'Viewport height for action=viewport, in CSS pixels (clamped to 480-2400).',
        },
        page: {
          type: 'string',
          description:
            'Which page an action targets: its key (p1, p2…), a URL substring, or a 1-based index. Omit to use the active page. Used by read/eval/screenshot/back/forward/reload/close/restore.',
        },
        newPage: {
          type: 'boolean',
          description: 'For action=open: open a fresh page instead of navigating the active one.',
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderText },
      timeoutMs: 60_000,
      execute: async (args) => {
        switch (args.action) {
          case 'status': {
            const status = browser.status();
            const lines = [statusLine(status)];
            if (status.humanCheck?.detected) {
              lines.push(
                '⚠ HUMAN VERIFICATION DETECTED on the active page — ask the user to complete it in the DSH right-Sidebar panel, then continue.',
              );
            }
            for (const page of status.pages ?? []) lines.push(pageLine(page));
            return {
              ok: true,
              text: lines.join('\n'),
              state: status.state,
              url: status.url,
              title: status.title,
              pages: status.pages,
            };
          }
          case 'open': {
            const result = await runCommand(browser, {
              action: 'open',
              url: args.url ?? '',
              newPage: args.newPage === true,
            });
            return {
              ok: true,
              text: `${statusLine(result)}\n(the live view is in the DSH right Sidebar — open the "Agent 浏览器" tab there to watch or take over)`,
              state: result.state,
              url: result.url,
              title: result.title,
              pages: result.pages,
            };
          }
          case 'read': {
            const page = await browser.read(args.page);
            return { ok: true, text: digest(page), page };
          }
          case 'eval': {
            if (!args.expression) return { ok: false, text: 'action=eval needs `expression`' };
            const value = await browser.evaluate(args.expression, args.page);
            return { ok: true, text: JSON.stringify(value, null, 2) ?? 'undefined', value };
          }
          case 'pages': {
            const pages = browser.listPages();
            const lines = [`${pages.length} page(s) known (${pages.filter((p) => p.state === 'live').length} live, ${pages.filter((p) => p.state === 'parked').length} parked):`];
            for (const page of pages) lines.push(pageLine(page));
            const policy = browser.status().policy;
            lines.push(
              `policy: park a page after ${policy.pageIdleTimeoutMin} min idle, stop the browser after ${policy.browserIdleTimeoutMin} min idle` +
                `${policy.restoreOnDemand ? ' (restored on demand)' : ''}, at most ${policy.maxLivePages} live pages`,
            );
            return { ok: true, text: lines.join('\n'), pages };
          }
          case 'close': {
            const result = await browser.closePage(args.page);
            // Report the page that was actually parked. status.url is the
            // ACTIVE page, which is a different one when a non-active page is
            // closed — the earlier version named the wrong key because of that.
            const closed = result.closed;
            if (result.ok === false || !closed) {
              return { ok: false, text: `could not park a page: ${result.reason ?? 'no such page'}`, pages: result.pages };
            }
            const already = result.reason === 'already parked';
            return {
              ok: true,
              text: already
                ? `${closed.key} was already parked — URL remembered: ${closed.url}`
                : `parked ${closed.key} (${closed.url}) — its URL stays on disk; restore with action=restore or just open it again`,
              url: closed.url,
              closed,
              pages: result.pages,
            };
          }
          case 'forget': {
            const status = await browser.forgetPage(args.page);
            if (status.forgotten === null) return { ok: false, text: `nothing to forget: ${status.reason}`, ...status };
            return {
              ok: true,
              text: `forgot ${status.forgotten.key} (${status.forgotten.url}) — it is gone from the remembered list, unlike a parked page\n${statusLine(status)}`,
              ...status,
            };
          }
          case 'activate': {
            const status = await browser.activatePage(args.page);
            return {
              ok: true,
              text: `the active page is now ${status.activeKey} — ${statusLine(status)}`,
              ...status,
            };
          }
          case 'restore': {
            const result = await browser.restorePage(args.page);
            const restored = result.restored;
            if (result.ok === false || !restored) {
              return { ok: false, text: `nothing to restore: ${result.reason ?? 'no remembered page'}`, pages: result.pages };
            }
            return {
              ok: true,
              text:
                result.reason === 'already live'
                  ? `${restored.key} is already live — ${statusLine(result)}`
                  : `restored ${restored.key} (${restored.url}) — ${statusLine(result)}`,
              url: restored.url,
              restored,
              pages: result.pages,
            };
          }
          case 'sweep': {
            const swept = await browser.sweep();
            return {
              ok: true,
              text: `sweep: parked ${swept.parked.length} page(s)${swept.parked.length ? ` (${swept.parked.join(', ')})` : ''}${swept.stopped ? `; stopped the browser (${swept.reason})` : ''}`,
              swept,
            };
          }
          case 'click':
          case 'move': {
            const action = args.action === 'click' && args.double ? 'doubleClick' : args.action;
            await browser.input({
              action,
              x: args.x,
              y: args.y,
              nx: args.nx,
              ny: args.ny,
            });
            const status = browser.status();
            return {
              ok: true,
              text: `${args.action === 'move' ? 'moved the pointer to' : `clicked ${args.double ? 'twice ' : ''}at`} ${describePoint(args)} — ${statusLine(status)}`,
              ...status,
            };
          }
          case 'drag': {
            if (args.toX === undefined && args.toNx === undefined) {
              return { ok: false, text: 'action=drag needs toX/toY (CSS px) or toNx/toNy (0..1) for the drop point' };
            }
            await browser.input({
              action: 'drag',
              x: args.x,
              y: args.y,
              nx: args.nx,
              ny: args.ny,
              toX: args.toX,
              toY: args.toY,
              toNx: args.toNx,
              toNy: args.toNy,
            });
            const status = browser.status();
            return {
              ok: true,
              text: `dragged from ${describePoint(args)} to ${describePoint(args, 'to')} along a hand-like path (press, travel, release) — ${statusLine(status)}`,
              ...status,
            };
          }
          case 'scroll': {
            const centred = args.x === undefined && args.nx === undefined;
            await browser.input({
              action: 'scroll',
              x: args.x,
              y: args.y,
              nx: centred ? 0.5 : args.nx,
              ny: centred ? 0.5 : args.ny,
              deltaX: args.deltaX,
              deltaY: args.deltaY,
            });
            const status = browser.status();
            return {
              ok: true,
              text: `scrolled (${args.deltaX ?? 0}, ${args.deltaY ?? 0})${centred ? ' at the viewport centre' : ` at ${describePoint(args)}`} — ${statusLine(status)}`,
              ...status,
            };
          }
          case 'type': {
            if (!args.text) return { ok: false, text: 'action=type needs `text`' };
            let target = 'the focused element';
            if (args.selector) {
              const focused = await browser.evaluate(`(() => {
                const el = document.querySelector(${JSON.stringify(args.selector)});
                if (!el) return null;
                el.focus();
                if (typeof el.select === 'function') el.select();
                return { tag: el.tagName.toLowerCase(), active: document.activeElement === el };
              })()`);
              if (!focused) return { ok: false, text: `action=type: no element matched ${args.selector}` };
              if (!focused.active) {
                return { ok: false, text: `action=type: ${args.selector} (<${focused.tag}>) would not take focus` };
              }
              target = args.selector;
            }
            await browser.input({ action: 'text', text: String(args.text) });
            if (args.submit) await browser.input({ action: 'key', key: 'Enter' });
            const status = browser.status();
            const value = await browser.evaluate(
              '(() => { const el = document.activeElement; return el && "value" in el ? String(el.value).slice(0, 200) : null; })()',
            );
            return {
              ok: true,
              text:
                `typed ${JSON.stringify(String(args.text))} into ${target}${args.submit ? ' and pressed Enter' : ''}` +
                `${value === null ? '' : ` — the field now reads ${JSON.stringify(value)}`} — ${statusLine(status)}`,
              value,
              ...status,
            };
          }
          case 'key': {
            if (!args.key) return { ok: false, text: 'action=key needs `key`, e.g. "Enter", "ArrowDown", "Tab"' };
            await browser.input({ action: 'key', key: String(args.key), modifiers: args.modifiers });
            const status = browser.status();
            const withModifiers = Array.isArray(args.modifiers) && args.modifiers.length > 0 ? ` with ${args.modifiers.join('+')}` : '';
            return { ok: true, text: `pressed ${args.key}${withModifiers} — ${statusLine(status)}`, ...status };
          }
          case 'downloads': {
            const { dir, items } = browser.downloads();
            if (items.length === 0) {
              return {
                ok: true,
                text: dir
                  ? `no downloads yet — files land in ${dir}`
                  : 'no downloads yet (this engine does not support download capture)',
                dir,
                downloads: [],
              };
            }
            const lines = [`${items.length} download(s), landing in ${dir ?? 'an unknown directory'}:`];
            for (const item of items.slice(-15)) {
              lines.push(`  [${item.state}] ${item.filename} — ${item.path}${item.bytes ? ` (${item.bytes} bytes)` : ''}`);
            }
            return { ok: true, text: lines.join('\n'), dir, downloads: items };
          }
          case 'import_logins': {
            const report = await browser.importLogins({
              source: args.source,
              domains: Array.isArray(args.domains) ? args.domains : [],
              dryRun: args.dryRun !== false,
            });
            const lines = [report.dryRun ? 'cookie stores found (nothing copied):' : 'import result:'];
            for (const source of report.sources) {
              lines.push(`  ${source.name} — ${source.cookies} cookie(s) over ${source.domains} domain(s) [${source.kind}]`);
            }
            if (report.dryRun) {
              lines.push(
                report.chosen.length > 0
                  ? `would import from: ${report.chosen.join(', ')}${report.domains.length ? ` (only ${report.domains.join(', ')})` : ''}`
                  : 'no store matched that source name',
              );
              lines.push('call again with dryRun: false to actually copy them into this browser');
            } else {
              for (const item of report.perSource) {
                lines.push(`  ${item.name}: read ${item.read}, imported ${item.imported}, failed ${item.failed} (${item.scheme})`);
              }
              lines.push(`total: ${report.imported} cookie(s) imported${report.failed ? `, ${report.failed} failed${report.firstError ? ` (${report.firstError})` : ''}` : ''}`);
            }
            return { ok: true, text: lines.join('\n'), ...report };
          }
          case 'cookies': {
            const cookies = await browser.cookies({ domain: args.domain });
            const shown = cookies.slice(0, 60);
            const lines = [`${cookies.length} cookie(s) in this browser${args.domain ? ` matching ${args.domain}` : ''}:`];
            for (const cookie of shown) {
              lines.push(`  ${cookie.name} @ ${cookie.domain}${cookie.path}${cookie.httpOnly ? ' httpOnly' : ''}${cookie.secure ? ' secure' : ''} (${cookie.valueLength} chars)`);
            }
            if (cookies.length > shown.length) lines.push(`  … and ${cookies.length - shown.length} more`);
            return { ok: true, text: lines.join('\n'), cookies: shown, total: cookies.length };
          }
          case 'engines': {
            if (!search) return { ok: false, text: 'search is unavailable in this host' };
            const engines = search.list();
            const snapshot = search.snapshot();
            const lines = [`${engines.length} pre-configured engine(s); active=${snapshot.active ?? 'none'}${snapshot.probedAt ? `, last probe ${snapshot.probedAt}` : ', never probed'}:`];
            lines.push(...engineLines(engines));
            lines.push('Search with action=search {query}; the engine is then chosen for you. Run action=probe to re-measure.');
            return { ok: true, text: lines.join('\n'), engines, ...snapshot };
          }
          case 'probe': {
            if (!search) return { ok: false, text: 'search is unavailable in this host' };
            const probe = await search.probe({
              engines: Array.isArray(args.engines) ? args.engines : undefined,
              query: args.query,
              timeoutMs: args.timeoutMs,
              select: args.select !== false,
            });
            const lines = [`probed ${probe.ranking.length} engine(s) with "${probe.query}" at ${probe.probedAt}:`];
            lines.push(...probe.ranking.map(probeLine));
            lines.push(
              probe.recommendation
                ? `picked ${probe.recommendation.id} (${probe.recommendation.why})${probe.pinned ? ` — note: config pins ${probe.pinned}, so searches still use that` : ''}`
                : 'no engine was usable — every candidate answered with a block or interstitial page',
            );
            return { ok: true, text: lines.join('\n'), ...probe };
          }
          case 'search': {
            if (!search) return { ok: false, text: 'search is unavailable in this host' };
            if (!args.query) return { ok: false, text: 'action=search needs `query` (the words to search for, not a URL)' };
            const result = await search.search(args.query, args.engine);
            const tried = (result.attempts ?? []).map((attempt) => `${attempt.id}:${attempt.status}`).join(' → ');
            if (result.blocked) {
              return {
                ok: false,
                text:
                  `search "${result.query}" was blocked on every attempt (${tried}).\n${result.note}\n` +
                  'The page left on screen is the block page, not results.',
                ...result,
              };
            }
            return {
              ok: true,
              text:
                `searched "${result.query}" via ${result.engine?.name ?? result.engine?.id} (${tried}) — ${statusLine(result.status)}\n` +
                `${result.url}\n(the live picture is in the DSH right Sidebar)`,
              ...result,
            };
          }
          case 'viewport': {
            const width = Number(args.width);
            const height = Number(args.height);
            if (!Number.isFinite(width) || !Number.isFinite(height)) {
              return { ok: false, text: 'action=viewport needs numeric `width` and `height` (CSS pixels)' };
            }
            const result = await browser.setViewport({ width, height });
            return {
              ok: true,
              text: result.ignored
                ? `viewport left at ${result.viewport.width}x${result.viewport.height} (${result.ignored})`
                : `viewport ${result.changed ? 'set to' : 'already'} ${result.viewport.width}x${result.viewport.height} — the panel keeps its own size in sync`,
              viewport: result.viewport,
            };
          }
          case 'back':
          case 'forward':
          case 'reload': {
            const result = await runCommand(browser, { action: args.action, page: args.page });
            return { ok: true, text: statusLine(result), url: result.url, title: result.title };
          }
          case 'screenshot': {
            const shot = await browser.screenshot(args.page);
            const bytes = Buffer.from(String(shot.data ?? ''), 'base64');
            // Hand the bytes to the attachment service so the model receives an
            // image it can look at; without that service the plain byte count is
            // all that can be reported, and saying so is better than pretending.
            let image;
            let note = 'the live picture is also in the DSH right Sidebar';
            if (attachments && !args.noImage) {
              try {
                image = await attachments.saveImage({
                  data: bytes,
                  mediaType: 'image/png',
                  name: `agent-browser-${Date.now()}.png`,
                });
                note = `attached as an image block${image.width ? ` (${image.width}x${image.height})` : ''}`;
              } catch (error) {
                note = `could not attach the image (${String(error?.message ?? error).slice(0, 120)}); ${bytes.length} bytes are still on disk-less in the panel`;
              }
            } else if (!attachments) {
              note = 'no attachment service is mounted, so only the byte count is reported';
            }
            return {
              ok: true,
              text: `captured ${shot.url} — ${note}`,
              url: shot.url,
              title: shot.title,
              bytes: bytes.length,
              ...(image ? { image } : {}),
            };
          }
          case 'stop': {
            const status = await browser.stop('agent requested');
            return { ok: true, text: `browser stopped (${status.state})`, state: status.state };
          }
          default:
            return { ok: false, text: `unsupported action "${args.action}"` };
        }
      },
      presentCall: () => ({ card: 'generic', title: 'Agent 浏览器', kind: 'other', rawInput: null }),
    }),
  );
}
