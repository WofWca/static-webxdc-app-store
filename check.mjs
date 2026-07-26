// Checks the source adapters in index.html against both live APIs: node check.mjs
// Slices them out of the page rather than duplicating them, so this can't drift.
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('index.html', import.meta.url), 'utf8');
const script = page.match(/<script>([\s\S]*)<\/script>/)[1];
const adapters = script.slice(script.indexOf('async function json'), script.indexOf('function card('));
const { SOURCES, rankRepos, pages, firstImageThatLoads } = await import('data:text/javascript,' +
  encodeURIComponent(adapters + 'export { SOURCES, rankRepos, pages, firstImageThatLoads };'));

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

// A repo may ship icon.png or icon.jpg, or neither. Walk the whole chain on a fake
// img: every candidate gets tried in order, and the final failure must clear the
// handler rather than retry, or a repo with no icon spins forever.
const fake = {};
firstImageThatLoads(fake, ['a.png', 'b.jpg', 'avatar']);
const tried = [fake.src];
while (fake.onerror) { fake.onerror(); tried.push(fake.src); }
ok(tried.join() === 'a.png,b.jpg,avatar,avatar', `wrong icon fallback order: ${tried}`);
ok(fake.onerror === null, 'icon fallback never stops, a repo with no icon would loop');

// Both forges currently fit one page, so force a page boundary with a tiny limit and
// check the walk lands on the same set a single big page returns. Codeberg only: it
// has no per-minute search quota to burn.
const cb = 'https://codeberg.org/api/v1/repos/search?topic=true&q=webxdc&limit=';
const [walked, oneShot] = await Promise.all([
  pages(cb + 5, 5, d => d.data),
  pages(cb + 50, 50, d => d.data),
]);
ok(oneShot.length > 5, `need >5 repos to cross a page boundary, got ${oneShot.length}`);
ok(walked.length === oneShot.length, `paged walk got ${walked.length}, single page ${oneShot.length}`);
ok(new Set(walked.map(r => r.full_name)).size === walked.length, 'paged walk returned duplicates');

// Rate limits are the one failure that must not lose data: two pages land, the third
// is refused, and the repos already in hand have to survive it. Stubbed fetch, so this
// costs no quota and doesn't depend on actually being throttled.
const realFetch = globalThis.fetch;
let asked = [];
globalThis.fetch = async url => {
  asked.push(url);
  return asked.length <= 2
    ? { ok: true, status: 200, json: async () => ({ items: [{ id: 1 }, { id: 2 }] }) }
    : { ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }) };
};

const partial = await pages('https://forge.test/search?q=x', 2, d => d.items).catch(e => e);
ok(Array.isArray(partial), `threw the fetched pages away instead of keeping them: ${partial.message}`);
ok(partial.length === 4, `dropped already-fetched repos: kept ${partial.length} of 4`);
ok(partial.error?.message === 'API rate limit exceeded', `no rate-limit reason: ${partial.error}`);
ok(asked.length === 3, `stopped late or retried: ${asked.length} requests`);
ok(asked.every((u, i) => u.endsWith(`&page=${i + 1}`)), `walked odd pages: ${asked}`);

// With nothing fetched there is nothing to show, so that still throws. The body is
// HTML here, as a throttled forge often answers, which must not surface as a JSON
// parse error.
asked = [];
globalThis.fetch = async url => {
  asked.push(url);
  return { ok: false, status: 429, json: async () => { throw new SyntaxError('Unexpected token <'); } };
};
const failure = await pages('https://forge.test/search?q=x', 2, d => d.items).catch(e => e);
ok(failure instanceof Error, 'a first page that fails should reject');
ok(failure.message === 'HTTP 429', `leaked a parse error instead of the status: ${failure.message}`);
ok(asked.length === 1, `retried a refused first page: ${asked.length} requests`);

globalThis.fetch = realFetch;

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
  for (const k of ['host', 'name', 'url', 'stars', 'updated', 'icons', 'avatar', 'topics'])
    ok(r[k] != null, `${r.host} ${r.name}: ${k} missing`);
ok(repos.every(r => r.icons.length === 2 && r.icons[0].endsWith('/icon.png')
  && r.icons[1].endsWith('/icon.jpg')), 'both spec icon formats should be offered');
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
