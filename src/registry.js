/**
 * The durable page registry.
 *
 * Pages are remembered on disk, not only in memory: a browser that has been
 * stopped (or whose pages were parked) must be able to come back with the same
 * URLs, because reopening one measured at ~32 ms for the target plus a normal
 * page load — cheap enough that reclaiming memory aggressively costs the caller
 * nothing perceptible.
 *
 * The file is written atomically (tmp + rename) and read tolerantly: a
 * truncated or hand-edited file degrades to "nothing remembered" instead of
 * failing the browser start.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';
import { writeJson } from './store.js';

/** Bumped only when the stored shape changes meaning. */
export const REGISTRY_VERSION = 1;
export const REGISTRY_FILE = 'pages.json';

/** Where the registry lives for the active environment. */
export function defaultRegistryPath() {
  return join(stateDir(), REGISTRY_FILE);
}

/** A tolerant read: unreadable, malformed, or wrong-version files read as empty. */
export function readRegistry(file = defaultRegistryPath()) {
  const empty = { version: REGISTRY_VERSION, savedAt: null, activeKey: null, pages: [] };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  if (parsed.version !== REGISTRY_VERSION) return empty;
  const pages = [];
  for (const entry of Array.isArray(parsed.pages) ? parsed.pages : []) {
    if (!entry || typeof entry !== 'object') continue;
    const key = typeof entry.key === 'string' ? entry.key : undefined;
    const url = typeof entry.url === 'string' ? entry.url : undefined;
    if (!key || !url) continue;
    pages.push({
      key,
      url,
      title: typeof entry.title === 'string' ? entry.title : '',
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
      lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : Date.now(),
    });
  }
  return {
    version: REGISTRY_VERSION,
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
    activeKey: typeof parsed.activeKey === 'string' ? parsed.activeKey : null,
    pages,
  };
}

/** An atomic write: never leave a half-written registry behind. */
export function writeRegistry(snapshot, file = defaultRegistryPath()) {
  return writeJson(file, {
    version: REGISTRY_VERSION,
    savedAt: new Date().toISOString(),
    activeKey: snapshot.activeKey ?? null,
    pages: snapshot.pages ?? [],
  });
}
