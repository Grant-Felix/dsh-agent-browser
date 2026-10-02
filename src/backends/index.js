/**
 * Which engine to drive, and the backend that speaks to it.
 *
 * The runtime knows nothing about protocols; it asks for a backend by name and
 * gets an object implementing the `#io` interface. Selection is explicit when
 * `browser` names an engine, and otherwise prefers whichever binary this host
 * actually has.
 */
import { resolveChromePath, resolveFirefoxPath } from '../config.js';
import { ChromiumBackend } from './chromium.js';
import { FirefoxBackend } from './firefox.js';

/**
 * Pick the engine for this config.
 * @param config - a resolved config.
 * @returns `'chromium'` or `'firefox'`.
 */
export function resolveEngine(config) {
  const wanted = config?.browser;
  if (wanted === 'chromium' || wanted === 'firefox') return wanted;
  // 'auto': Chromium is the default this project ships and measures most; Firefox
  // only wins when no Chromium binary exists at all.
  return resolveChromePath(config) ? 'chromium' : 'firefox';
}

/**
 * The binary the selected engine will run.
 * @param config - a resolved config.
 * @returns the absolute path, or `undefined` when it is missing.
 */
export function resolveEngineBinary(config) {
  return resolveEngine(config) === 'firefox' ? resolveFirefoxPath(config) : resolveChromePath(config);
}

/**
 * Build the backend for this config.
 * @param config - a resolved config.
 * @param log - the runtime's logger.
 * @returns the backend instance.
 */
export function createBackend(config, log) {
  const engine = resolveEngine(config);
  return engine === 'firefox' ? new FirefoxBackend({ log, config }) : new ChromiumBackend({ log, config });
}
