/**
 * Import logins from the user's real browser profiles.
 *
 * Two facts decide this design, both measured on this machine:
 *
 * 1. **Chromium-family cookies are encrypted** (`v11` here): AES-128-CBC with a
 *    key derived from the OS keyring password (PBKDF2-HMAC-SHA1, salt `saltysalt`,
 *    1 iteration, 16 bytes), IV of 16 spaces, and a plaintext of
 *    `SHA256(host_key) || value`. The domain hash is what proves a decryption is
 *    right instead of merely plausible — verified 6/6 on Helium's store.
 *    path is a plain read.
 *
 * Everything is read through `node:sqlite` and `node:crypto`, so there is no
 * dependency, and the stores are opened READ-ONLY. Values are never logged: the
 * reports carry counts, domains and cookie names only.
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `node:sqlite` is loaded lazily so an older Node degrades to "unavailable". */
const require = createRequire(import.meta.url);

/** Keyring entries to try, in order, for a Chromium-family store. */
const KEYRING_APPS = ['chromium', 'chrome', 'google-chrome', 'helium', 'brave', 'microsoft-edge'];

/** Read one cookie database, read-only. */
function openDatabase(file) {
  // Required lazily: `node:sqlite` is only present on modern Node, and a missing
  // module must degrade to "import unavailable", not break the plugin.
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

/** The OS-keyring password Chromium used for its cookie key, when available. */
export function keyringPassword(apps = KEYRING_APPS) {
  for (const app of apps) {
    try {
      const value = execFileSync('secret-tool', ['lookup', 'application', app], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).replace(/\n$/, '');
      if (value) return { password: value, app };
    } catch {
      // No entry under that name; try the next.
    }
  }
  return null;
}

/**
 * Decrypt one Chromium cookie value.
 * @returns `{ value, verified }` — `verified` means the domain hash matched.
 */
export function decryptChromiumValue(encrypted, hostKey, key) {
  const buffer = Buffer.from(encrypted);
  const prefix = buffer.subarray(0, 3).toString();
  if (!prefix.startsWith('v1')) {
    // v20 (App-Bound Encryption) is not decryptable this way; say so instead of
    // returning garbage.
    return { value: null, verified: false, scheme: prefix };
  }
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const plain = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
  // Chromium >= 104 stores SHA256(host_key) ahead of the value.
  const hash = createHash('sha256').update(hostKey).digest();
  const hasHash = plain.length >= 32 && plain.subarray(0, 32).equals(hash);
  const value = (hasHash ? plain.subarray(32) : plain).toString('utf8');
  return { value, verified: hasHash, scheme: prefix };
}

/** Derive the AES key from a keyring password. */
export function deriveKey(password) {
  return pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
}

/** Every Chromium-family profile directory that exists. */
function chromiumProfiles(home = homedir()) {
  const roots = [
    join(home, '.config', 'net.imput.helium'),
    join(home, '.config', 'google-chrome'),
    join(home, '.config', 'chromium'),
    join(home, '.config', 'BraveSoftware', 'Brave-Browser'),
    join(home, '.config', 'microsoft-edge'),
    join(home, '.local', 'share', 'ego-lite-linux', 'profile'),
    join(home, '.local', 'share', 'dsh-agent-browser', 'profile'),
  ];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Modern Chromium keeps cookies under <profile>/Network/Cookies.
      const candidates = [
        join(root, entry.name, 'Network', 'Cookies'),
        join(root, entry.name, 'Cookies'),
      ];
      for (const file of candidates) {
        if (existsSync(file)) {
          found.push({ kind: 'chromium', name: `${root.split('/').slice(-2).join('/')}${entry.name === 'Default' ? '' : `/${entry.name}`}`, file, app: root.split('/').pop() });
          break;
        }
      }
    }
  }
  return found;
}

/**
 * List every cookie store this machine has, with counts but no values.
 * @returns `[{ kind, name, file, cookies, domains }]`.
 */
export function listCookieSources({ home = homedir() } = {}) {
  const sources = [];
  for (const source of chromiumProfiles(home)) {
    try {
      const db = openDatabase(source.file);
      const row = db.prepare('SELECT COUNT(*) AS cookies, COUNT(DISTINCT host_key) AS domains FROM cookies').get();
      db.close();
      sources.push({ ...source, cookies: row.cookies, domains: row.domains });
    } catch (error) {
      sources.push({ ...source, cookies: 0, domains: 0, error: String(error?.message ?? error).slice(0, 80) });
    }
  }
  return sources;
}

/**
 * Read cookies out of one store.
 * @param source - an entry from {@link listCookieSources}.
 * @param options - `domains` to filter by suffix; `limit` as a safety cap.
 * @returns `{ cookies, decrypted, failed, scheme }` — values included, never logged.
 */
export function readCookies(source, { domains = [], limit = 4000 } = {}) {
  const db = openDatabase(source.file);
  const filter = domains.length > 0 ? domains : null;
  // Chromium stores expiry as MICROseconds since 1601, which exceeds
  // Number.MAX_SAFE_INTEGER — asking for it directly makes node:sqlite throw
  // "Value is too large to be represented as a JavaScript number", so SQLite does
  // the arithmetic itself.
  const query = `SELECT host_key, name, value, encrypted_value, path,
                CAST(expires_utc / 1000000 - 11644473600 AS INTEGER) AS expires_unix,
                is_secure, is_httponly, samesite
         FROM cookies LIMIT ?`;
  const rows = db.prepare(query).all(limit);
  db.close();

  const found = keyringPassword([source.app, ...KEYRING_APPS].filter(Boolean));
  if (!found) return { cookies: [], decrypted: 0, failed: rows.length, scheme: 'none', error: 'no keyring password available' };
  const key = deriveKey(found.password);

  const cookies = [];
  let decrypted = 0;
  let failed = 0;
  let scheme = 'unknown';
  for (const row of rows) {
    const host = String(row.host_key ?? '');
    if (filter && !filter.some((domain) => host === domain || host.endsWith(domain) || host.endsWith(`.${domain}`))) continue;
    let value = row.value ?? '';
    if (row.encrypted_value) {
      try {
        const result = decryptChromiumValue(row.encrypted_value, host, key);
        scheme = result.scheme ?? scheme;
        if (result.value === null) {
          failed += 1;
          continue;
        }
        value = result.value;
        decrypted += 1;
      } catch {
        failed += 1;
        continue;
      }
    }
    if (value === '') continue;
    cookies.push({
      name: String(row.name),
      value: String(value),
      domain: host,
      path: String(row.path ?? '/'),
      expires: expiryFrom(row.expires_unix),
      secure: Boolean(row.is_secure),
      httpOnly: Boolean(row.is_httponly),
      sameSite: sameSiteName(row.samesite),
    });
  }
  return { cookies, decrypted, failed, scheme };
}

/** Unix seconds for an expiry, or null for a session cookie. */
function expiryFrom(raw) {
  const value = Number(raw ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** Chromium's numeric same-site column to the string the protocols want. */
function sameSiteName(raw) {
  const value = Number(raw ?? 0);
  if (value === 1) return 'Lax';
  if (value === 2) return 'Strict';
  if (value === 0) return 'None';
  return null;
}
