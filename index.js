/**
 * Host half of the agent browser.
 *
 * Owns one `AgentBrowser` runtime and publishes it two ways: as the
 * `agent_browser` tool for the model, and as the `/api/agent-browser` HTTP face
 * for the Sidebar panel. The Client half registers the panel itself.
 */
import z from '@deepseek-ai/schemastery';
import { AgentBrowser } from './src/browser.js';
import { describeResolution, resolveConfig } from './src/config.js';
import { registerRoutes } from './src/routes.js';
import { SearchService } from './src/search.js';
import { registerTools } from './src/tools.js';

export const name = 'dsh-agent-browser';

/** The tool registry is the one service this plugin cannot work without. */
export const inject = ['tools'];

/** Every field is optional; an empty row installs a working default browser. */
export const Config = z.object({
  chromePath: z.string().default(''),
  // 'auto' = Chromium when present, otherwise Firefox.
  browser: z.union([z.const('auto'), z.const('chromium'), z.const('firefox')]).default('auto'),
  firefoxPath: z.string().default(''),
  // 'auto' = headed when a display is reachable, headless otherwise.
  // There is one display mode (headed, with the Sidebar panel as the head), so
  // there is no headless or visible-window setting to configure.
  // The screen used before the Sidebar panel reports its own measured size.
  virtualScreenWidth: z.natural().default(1280),
  virtualScreenHeight: z.natural().default(900),
  userDataDir: z.string().default(''),
  startUrl: z.string().default('about:blank'),
  // 0 = AUTO: no assumed screen size. The panel measures its own column and
  // follows it live (including devicePixelRatio changes); these rails only
  // reject absurd values, they are not a preferred size.
  viewportWidth: z.natural().default(0),
  viewportHeight: z.natural().default(0),
  viewportFollowsPanel: z.boolean().default(true),
  viewportMinWidth: z.natural().default(320),
  viewportMinHeight: z.natural().default(240),
  viewportMaxWidth: z.natural().default(10000),
  viewportMaxHeight: z.natural().default(10000),
  humanizeInput: z.boolean().default(true),
  downloadDir: z.string().default(''),
  hideWebdriver: z.boolean().default(true),
  pointerModel: z.union([z.const('human'), z.const('linear')]).default('human'),
  pointerSpeedPxPerSec: z.natural().default(900),
  pointerJitter: z.number().default(1),
  typingIntervalMs: z.natural().default(90),
  typingJitterMs: z.natural().default(70),
  pressDwellMs: z.natural().default(60),
  fps: z.natural().default(12),
  jpegQuality: z.natural().default(60),
  maxWidth: z.natural().default(1600),
  extraArgs: z.array(z.string()).default([]),
  pageIdleTimeoutMin: z.natural().default(180),
  browserIdleTimeoutMin: z.natural().default(360),
  restoreOnDemand: z.boolean().default(true),
  maxLivePages: z.natural().default(8),
  sweepIntervalSec: z.natural().default(60),
  // Search: engines are pre-configured; the choice is measured, not assumed.
  searchEngine: z.string().default(''),
  searchEngines: z
    .array(
      z.object({
        id: z.string(),
        url: z.string(),
        name: z.string().default(''),
      }),
    )
    .default([]),
  searchProbeQuery: z.string().default('wikipedia'),
  searchProbeTimeoutMs: z.natural().default(8000),
  searchSelectionTtlHours: z.natural().default(24),
  searchMaxAttempts: z.natural().default(3),
});

/**
 * Activate the plugin.
 * @param ctx - the plugin context.
 * @param config - the row config, already validated against `Config`.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[agent-browser] ${message}`);
    } catch {
      // Logging must never break activation.
    }
  };

  const browser = new AgentBrowser({ config: resolved, log });
  const search = new SearchService({ browser, config: resolved, log });

  ctx.effect(() => registerTools(ctx, browser, search), 'dsh-agent-browser: agent_browser tool');

  // The panel route is registered through a DEFERRED injection, not by reading
  // `ctx.get('webServer')` here. On a cold boot this plugin can be applied
  // before the web server service activates; a lookup that early returns
  // undefined and the route then never exists (observed 2026-10-02 on a fresh
  // `dsh web`: the tools worked while /api/agent-browser fell through to the
  // connection channel as 401). `ctx.inject` re-runs whenever the dependency
  // becomes available, so the route appears in any activation order.
  let panelRoute = 'pending';
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        webCtx.effect(() => registerRoutes(webCtx.webServer, browser, search), 'dsh-agent-browser: panel route');
        panelRoute = 'registered';
      } catch (error) {
        panelRoute = 'failed';
        log(`could not register the panel route: ${error?.message ?? error}`);
      }
    });
  } else {
    // Host without the deferred-injection API: register now if the service
    // happens to be up (the pre-fix behaviour), and say so in the log.
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    if (webServer) {
      ctx.effect(() => registerRoutes(webServer, browser, search), 'dsh-agent-browser: panel route');
      panelRoute = 'registered (no ctx.inject)';
    } else {
      panelRoute = 'unregistered (no ctx.inject, webServer not up yet)';
    }
  }

  ctx.effect(
    () => () => {
      void browser.dispose();
    },
    'dsh-agent-browser: runtime teardown',
  );

  const resolution = describeResolution(resolved);
  log(
    `ready | chrome=${resolution.chromePath ?? 'NOT FOUND'} | profile=${resolution.userDataDir} | headless=${resolution.headless} | panel route=${panelRoute}`,
  );
}
