// Checks the source adapters in index.html against both live APIs: node check.mjs
// Slices them out of the page rather than duplicating them, so this can't drift.
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('index.html', import.meta.url), 'utf8');
const script = page.match(/<script>([\s\S]*)<\/script>/)[1];
const adapters = script.slice(script.indexOf('async function json'), script.indexOf('function card('));
const { SOURCES, rankRepos } = await import('data:text/javascript,' +
  encodeURIComponent(adapters + 'export { SOURCES, rankRepos };'));

let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.error('FAIL:', msg); } };

// rankRepos() is pure, so check the ordering rules directly: webxdc-app repos first,
// stars breaking ties. 99 stars must not lift a plain repo above a 1-star app.
const ranked = rankRepos([
  { name: 'few-stars-app', stars: 1, topics: ['webxdc-app'] },
  { name: 'many-stars-plain', stars: 99, topics: ['webxdc'] },
  { name: 'no-topics', stars: 50, topics: [] },
  { name: 'more-stars-app', stars: 2, topics: ['webxdc', 'webxdc-app'] },
]);
ok(ranked.map(r => r.name).join() === 'more-stars-app,few-stars-app,many-stars-plain,no-topics',
  'wrong ranking: ' + ranked.map(r => r.name).join());

const names = Object.keys(SOURCES);
const results = await Promise.allSettled(names.map(n => SOURCES[n]('webxdc-app,webxdc')));
const repos = rankRepos(results.flatMap(r => r.value || []));

for (const [i, r] of results.entries())
  ok(r.status === 'fulfilled' && r.value.length > 0, `${names[i]}: ${r.reason?.message ?? 'no repos'}`);
// Both forges read a comma-separated topic list as OR: a repo tagged only with the
// first topic must still come back, or coverage silently shrinks to one topic.
ok(repos.some(r => r.topics.includes('webxdc-app') && !r.topics.includes('webxdc')),
  'comma topic list is not being treated as OR');
for (const r of repos)
  for (const k of ['host', 'name', 'url', 'stars', 'updated', 'icon', 'avatar', 'topics'])
    ok(r[k] != null, `${r.host} ${r.name}: ${k} missing`);
ok(new Set(repos.map(r => r.host)).size === names.length, 'a forge contributed nothing');
ok(repos.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.updated.slice(0, 10))), 'unexpected date format');
// r.updated goes straight into <time datetime>, so it has to be a real timestamp.
ok(repos.every(r => !Number.isNaN(Date.parse(r.updated))), 'unparseable timestamp');
// Every repo tagged webxdc-app must precede every repo that isn't.
const lastApp = repos.findLastIndex(r => r.topics.includes('webxdc-app'));
const firstOther = repos.findIndex(r => !r.topics.includes('webxdc-app'));
ok(lastApp < firstOther || firstOther === -1, 'webxdc-app repos are not all at the top');

console.log(names.map((n, i) => `${n}: ${results[i].value?.length ?? 'failed'}`).join(', '));
console.log(`${repos.length} total, ${lastApp + 1} tagged webxdc-app`);
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
