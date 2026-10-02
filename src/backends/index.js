/**
 * Which engine to drive, and the backend that speaks to it.
 *
 * The runtime knows nothing about protocols: it asks for a backend and gets an
 * object implementing the `#io` interface. This project ships ONE engine —
 * Chromium over CDP. Firefox (WebDriver BiDi) was removed on purpose: two engines
 * meant two protocols, two profile layouts and twice the surface to keep honest.
 * It belongs in its own project if it comes back.
 */
import { resolveChromePath } from '../config.js';
import { ChromiumBackend } from './chromium.js';

/**
 * The engine this build drives.
 * @returns `'chromium'`.
 */
export function resolveEngine() {
  return 'chromium';
}

/**
 * The binary the engine will run.
 * @param config - a resolved config.
 * @returns the absolute path, or `undefined` when it is missing.
 */
export function resolveEngineBinary(config) {
  return resolveChromePath(config);
}

/**
 * Build the backend.
 * @param config - a resolved config.
 * @param log - the runtime's logger.
 * @returns the backend instance.
 */
export function createBackend(config, log) {
  return new ChromiumBackend({ log, config });
}
