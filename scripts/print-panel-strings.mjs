/**
 * Print every user-visible string in the panel, straight out of `client.js`.
 *
 *   node scripts/print-panel-strings.mjs
 *
 * Documentation kept describing labels the panel did not render ("dormant
 * placeholder" for a paragraph that never used the word). This makes the labels
 * checkable instead of remembered: the README's panel section is this output.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const pick = (name, next) => {
  const start = source.indexOf(`const ${name} = {`);
  const end = next ? source.indexOf(`const ${next} = {`) : source.length;
  if (start === -1) return [];
  return [...source.slice(start, end).matchAll(/'([a-zA-Z.]+)':\s*'((?:[^'\\]|\\.)*)'/g)].map(([, key, value]) => ({ key, value }));
};

const zh = pick('zh', 'en');
const en = pick('en', 'const NS');
const enMap = new Map(en.map((entry) => [entry.key, entry.value]));

const width = Math.max(...zh.map((entry) => entry.key.length));
console.log(`panel strings (${zh.length} keys, from client.js)\n`);
console.log(`${'key'.padEnd(width)}  zh / en`);
console.log(`${'-'.repeat(width)}  ${'-'.repeat(60)}`);
for (const { key, value } of zh) {
  console.log(`${key.padEnd(width)}  ${value}`);
  console.log(`${' '.repeat(width)}  ${enMap.get(key) ?? '(missing in en)'}`);
}
