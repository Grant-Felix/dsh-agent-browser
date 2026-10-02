/**
 * Turn the four matrix runs into one comparison table.
 *
 *   node scripts/aggregate-matrix.mjs
 *
 * Reads `.dev/matrix-<engine>-<mode>.json` and prints, per system, what each
 * engine/mode combination got — the deliverable is the table, not a summary.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = '.dev';
const files = readdirSync(dir).filter((name) => /^matrix-.*\.json$/.test(name));
if (files.length === 0) {
  console.log('no matrix results yet');
  process.exit(0);
}

const quadrants = files
  .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
  .sort((a, b) => `${a.engine}-${a.mode}`.localeCompare(`${b.engine}-${b.mode}`));
quadrants.sort((a, b) => `${a.engine}-${a.mode}`.localeCompare(`${b.engine}-${b.mode}`));

const ids = [...new Set(quadrants.flatMap((q) => q.results.map((r) => r.id)))];
const cell = (q, id) => {
  const row = q.results.find((r) => r.id === id);
  if (!row) return '—';
  // A row that has no pass/fail meaning (a fingerprinting page) is shown as info
  // and left out of every count, instead of being read as a failed check.
  if (row.informational) return 'info';
  const mark = { pass: 'PASS', fail: 'FAIL', blocked: 'BLOCKED', challenge: 'challenge', flagged: 'FLAGGED', unknown: '?', unreachable: 'unreachable', error: 'error' }[row.state] ?? row.state;
  return row.attempted ? `${mark}${row.state === 'pass' ? ' (dragged)' : ''}` : mark;
};

const width = 20;
console.log(`\n=== pass-rate matrix (${quadrants.length} quadrant(s)) ===\n`);
// Print the mode by its real name: there is no headed/headless axis any more.
console.log(`  ${'system'.padEnd(width)} ${quadrants.map((q) => `${q.engine}/${q.mode}`.padEnd(24)).join('')}`);
console.log(`  ${'-'.repeat(width + 18 * quadrants.length)}`);
for (const id of ids) {
  console.log(`  ${id.padEnd(width)} ${quadrants.map((q) => cell(q, id).padEnd(18)).join('')}`);
}

console.log('');
for (const q of quadrants) {
  const counts = q.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const passed = counts.pass ?? 0;
  console.log(`  ${`${q.engine}/${q.mode}`.padEnd(20)} pass ${String(passed).padStart(2)}/${total}   ${JSON.stringify(counts)}`);
}

// Detail for the systems that needed a decision, so the table is not the only output.
console.log('\n=== details (state — evidence) ===');
for (const q of quadrants) {
  console.log(`\n  ${q.engine}/${q.mode}:`);
  for (const row of q.results) {
    const timing = row.settledAfterMs ? ` [settled ${(row.settledAfterMs / 1000).toFixed(1)}s]` : '';
    console.log(`    ${row.id.padEnd(16)} ${String(row.state).padEnd(10)}${timing} ${row.detail}`);
  }
}
