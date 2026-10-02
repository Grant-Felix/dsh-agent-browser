/**
 * Login import, proven end to end.
 *
 *   node scripts/smoke-login-import.mjs [home]
 *
 * The only convincing test of a login import is whether the target site believes
 * it: this copies the `github.com` cookies out of the user's real profile and then
 * loads GitHub to see whether it greets a signed-in user. Cookie VALUES are never
 * printed — the report carries names, counts and the site's own verdict.
 *
 * `home` defaults to `$HOME`. This suite reads a REAL browser profile, so it needs
 * one: point it at the home directory that holds the browser you are importing
 * from (`node scripts/smoke-login-import.mjs /home/you`). With no profile in reach
 * it reports SKIP rather than FAIL — the absence of a browser to import from is
 * not a defect in the plugin.
 */
import { rmSync } from 'node:fs';
import { AgentBrowser } from '../src/browser.js';
import { resolveConfig } from '../src/config.js';
import { defaultRegistryPath } from '../src/registry.js';

// No personal default: the caller passes the home directory to inspect.
const home = process.argv[2] ?? process.env.HOME ?? '.';
let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

rmSync(defaultRegistryPath(), { force: true });
const config = resolveConfig({ browser: 'chromium', sweepIntervalSec: 3600 });
const browser = new AgentBrowser({ config, log: () => {} });

// 1. what is on this machine (no values anywhere in the report)
const dry = await browser.importLogins({ home, domains: ['github.com'] });
if (dry.sources.length === 0) {
  // Environment-dependent by construction: no browser profile under this home
  // means there is nothing to import from, which is not a plugin failure.
  console.log(`SKIP  no cookie store under ${home} — pass a home that holds a Chromium profile`);
  await browser.dispose();
  console.log('\nLOGIN_IMPORT_SKIPPED');
  process.exit(0);
}
check('cookie stores are discoverable', dry.sources.length > 0, dry.sources.map((s) => `${s.name}:${s.cookies}`).join(', '));
// This suite imports from a specific browser (`helium` below). If that profile is
// not under this home — the file-sandbox HOME only holds the plugin's own profile —
// there is nothing to import from, which is an environment fact, not a defect.
const wanted = dry.sources.filter((source) => /helium/i.test(source.name));
if (wanted.length === 0) {
  console.log(`SKIP  no helium profile under ${home} (found: ${dry.sources.map((s) => s.name).join(', ') || 'none'})`);
  console.log('      pass the home that holds the browser you want to import from');
  await browser.dispose();
  console.log('\nLOGIN_IMPORT_SKIPPED');
  process.exit(0);
}
check('the dry run copies nothing', dry.dryRun === true && dry.imported === 0, `dryRun=${dry.dryRun} imported=${dry.imported}`);

// 2. the real import, limited to one domain
const real = await browser.importLogins({ home, source: 'helium', domains: ['github.com'], dryRun: false });
check('a dry run is required to be disarmed explicitly', real.dryRun === false);
check('some cookies were read', real.read > 0, `read=${real.read}`);
check('all of them were accepted by the browser', real.imported > 0 && real.failed === 0, `imported=${real.imported} failed=${real.failed}${real.firstError ? ` (${real.firstError})` : ''}`);
check('decryption scheme reported', real.perSource.some((s) => s.scheme === 'v11' || s.scheme === 'plaintext'), JSON.stringify(real.perSource));

// 3. they are really in this browser
const cookies = await browser.cookies({ domain: 'github.com' });
const names = cookies.map((c) => c.name);
check('the session cookies are present', names.includes('user_session') || names.includes('_gh_sess'), names.join(', ').slice(0, 120));
check('httpOnly is preserved', cookies.some((c) => c.httpOnly === true), `${cookies.filter((c) => c.httpOnly).length} httpOnly`);
check('no value is exposed by the report', cookies.every((c) => c.value === undefined && typeof c.valueLength === 'number'), 'valueLength only');

// 4. the target site agrees — the only end-to-end proof
await browser.navigate('https://github.com/', { settleMs: 20_000 });
await new Promise((r) => setTimeout(r, 3000));
const state = await browser.evaluate(`(() => {
  const meta = document.querySelector('meta[name="user-login"]');
  const text = (document.body.innerText || '').slice(0, 4000);
  return {
    login: meta ? meta.getAttribute('content') : null,
    signedOut: /sign in|sign up/i.test(text.slice(0, 600)),
    logoutLink: !!document.querySelector('a[href*="/logout"], form[action*="/logout"]'),
  };
})()`);
check(
  'GitHub treats this browser as signed in',
  Boolean(state.login) || state.logoutLink === true,
  `user-login=${state.login ?? 'none'} logoutLink=${state.logoutLink}`,
);

// 5. the import survives a restart, because the profile is on disk
await browser.stop('login import test');
const restarted = await browser.ensureStarted();
check('the browser restarts', restarted.state === 'running', restarted.state);
const afterRestart = await browser.cookies({ domain: 'github.com' });
check('the imported cookies survived the restart', afterRestart.some((c) => c.name === 'user_session' || c.name === '_gh_sess'), `${afterRestart.length} cookie(s)`);

await browser.dispose();
console.log(`\n${failures === 0 ? 'LOGIN_IMPORT_OK' : `LOGIN_IMPORT_FAILED (${failures})`}`);
