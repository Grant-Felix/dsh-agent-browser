/**
 * Tiny durable JSON stores: a tolerant read and an atomic write.
 *
 * Two files use this — the page registry and the search-engine state — and the
 * same two rules apply to both: a truncated or hand-edited file must degrade to
 * "nothing remembered" instead of failing a browser start, and a write must never
 * leave a half-written file behind.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Read a JSON file, returning `fallback` for anything unreadable or malformed.
 * @param file - absolute path.
 * @param fallback - value to return when the file cannot be used.
 * @returns the parsed value or the fallback.
 */
export function readJson(file, fallback) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * Write JSON atomically (tmp + rename).
 * @param file - absolute path.
 * @param value - JSON-serializable value.
 * @returns whether the write landed.
 */
export function writeJson(file, value) {
  const payload = JSON.stringify(value, null, 2);
  const temp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, payload);
    renameSync(temp, file);
    return true;
  } catch {
    rmSync(temp, { force: true });
    return false;
  }
}
