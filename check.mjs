// Checks the source adapters in index.html against both live APIs: node check.mjs
// Slices them out of the page rather than duplicating them, so this can't drift.
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('index.html', import.meta.url), 'utf8');
const script = page.match(/<script>([\s\S]*)<\/script>/)[1];
const adapters = script.slice(script.indexOf('async function json'), script.indexOf('function card('));
const { SOURCES } = await import('data:text/javascript,' +
  encodeURIComponent(adapters + 'export { SOURCES };'));

const names = Object.keys(SOURCES);
const results = await Promise.allSettled(names.map(n => SOURCES[n]('webxdc')));
const repos = results.flatMap(r => r.value || []);
repos.sort((a, b) => b.stars - a.stars);

let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.error('FAIL:', msg); } };

for (const [i, r] of results.entries())
  ok(r.status === 'fulfilled' && r.value.length > 0, `${names[i]}: ${r.reason?.message ?? 'no repos'}`);
for (const r of repos)
  for (const k of ['host', 'name', 'url', 'stars', 'updated', 'icon', 'avatar'])
    ok(r[k] != null, `${r.host} ${r.name}: ${k} missing`);
ok(repos.every((r, i) => i === 0 || repos[i - 1].stars >= r.stars), 'not sorted by stars');
ok(new Set(repos.map(r => r.host)).size === names.length, 'a forge contributed nothing');
ok(repos.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.updated.slice(0, 10))), 'unexpected date format');
// r.updated goes straight into <time datetime>, so it has to be a real timestamp.
ok(repos.every(r => !Number.isNaN(Date.parse(r.updated))), 'unparseable timestamp');

console.log(results.map((r, i) => `${names[i]}: ${r.value?.length ?? 'failed'}`).join(', '),
  `| ${repos.length} total`);
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
