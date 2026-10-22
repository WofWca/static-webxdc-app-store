// Prints star counts for the webxdc.org store's apps as JSON:
//   node fetch-store-stars.mjs > store-stars.json
// or paste it into a browser console.
// The store's list has no star counts, and asking each forge live
// would cost a request per app, so index.html reads them
// from store-stars.json instead.

async function json(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url}: ${data.message || `HTTP ${res.status}`}`);
  return data;
}

// Must match repoKey() in index.html, which looks these up.
const repoKey = url => url.toLowerCase().replace(/\/$/, '');

const apps = await json('https://apps.testrun.org/xdcget-lock.json');
const repos = apps.map(a => new URL(a.source_code_url));
const stars = {};

// One search can name many repos, so ~120 repos cost 3 requests rather than
// overrunning the anonymous 60/hour core limit. Search leaves out forks unless told.
const github = repos.filter(u => u.host === 'github.com').map(u => u.pathname.replace(/^\/|\/$/g, ''));
for (let i = 0; i < github.length; i += 50) {
  const q = ['fork:true', ...github.slice(i, i + 50).map(r => `repo:${r}`)].join(' ');
  const { items } = await json(`https://api.github.com/search/repositories?per_page=100&q=${encodeURIComponent(q)}`);
  for (const r of items) stars[repoKey(r.html_url)] = r.stargazers_count;
}

// Codeberg has no shared search quota to protect, so plain per-repo lookups do.
// One at a time: fired all at once, a few of them get their connection dropped.
for (const u of repos.filter(u => u.host === 'codeberg.org')) {
  try {
    const r = await json(`https://codeberg.org/api/v1/repos${u.pathname.replace(/\/$/, '')}`);
    stars[repoKey(u.href)] = r.stars_count;
  } catch (e) {
    console.error(u.href, e.message);
  }
}

// A renamed or deleted repo comes back under another name or not at all. It just
// goes without stars, but say so, since its store entry probably needs fixing.
const missing = repos.filter(u => !(repoKey(u.href) in stars));
for (const u of missing) console.error('no stars for', u.href);

const sorted = Object.fromEntries(Object.entries(stars).sort(([a], [b]) => a.localeCompare(b)));
console.log(JSON.stringify(sorted, null, 1));
console.error(`${Object.keys(sorted).length} of ${repos.length} store apps have stars`);
