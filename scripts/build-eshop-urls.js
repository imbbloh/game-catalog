// Generates Nintendo eShop store URLs for every game title in the
// "Raw Data - Digital Codes" tab (column C) and verifies each candidate
// against nintendo.com. Output: eshop-urls.csv — row-aligned with the sheet
// so the URL column can be pasted directly into column F.
//
// Run by .github/workflows/eshop-urls.yml (manual dispatch).
const fs = require('fs');

const SHEET_ID  = '1ly37Y9r-_q44Fp7DpfMVlo_8JdYPHCHwapA6kHy-msw';
const TAB       = 'Raw Data - Digital Codes';
const TITLE_COL = 2; // column C
const CONCURRENCY = 2; // gentle: nintendo.com rate-limits aggressive crawling

// Base cleanup: lowercase, drop accents (é→e), trademark marks, apostrophes,
// and the "(Switch 2 Edition)" marker — mirrors the column F sheet formula.
function clean(title) {
  return String(title)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[™®©'’]/g, '')
    .replace(/\(switch 2 edition\)/g, '');
}

function hyphenate(s) {
  return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The slug the sheet formula produces — first candidate tried.
function formulaSlug(title) {
  return hyphenate(clean(title));
}

// Alternate slugs Nintendo actually uses for some titles.
function slugVariants(title) {
  const c = clean(title);
  const variants = [
    hyphenate(c),
    hyphenate(c.replace(/&/g, ' and ').replace(/\+/g, ' ')),
    hyphenate(c.replace(/&/g, ' and ').replace(/\+/g, ' plus ')),
    hyphenate(c.replace(/\([^)]*\)/g, ' ')), // drop "(DLC)", "(Upgrade Pack)", …
    hyphenate(c.replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').replace(/\+/g, ' plus ')),
  ];
  return [...new Set(variants)].filter(Boolean);
}

function candidates(title) {
  const isSwitch2 = /switch\s*2/i.test(title);
  const suffixes = isSwitch2 ? ['-switch-2/', '-switch/', '/'] : ['-switch/', '-switch-2/', '/'];
  const urls = [];
  slugVariants(title).forEach(slug => {
    suffixes.forEach(suf => urls.push(`https://www.nintendo.com/us/store/products/${slug}${suf}`));
  });
  return [...new Set(urls)];
}

// What the sheet formula would emit for this title (to compare against).
function formulaUrl(title) {
  const suf = /switch\s*2/i.test(title) ? '-switch-2/' : '-switch/';
  return `https://www.nintendo.com/us/store/products/${formulaSlug(title)}${suf}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// true = page exists, false = definitive 404, 'blocked' = rate-limited
async function urlOk(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      await sleep(250); // pace requests
      if (res.status === 200) return true;
      if (res.status === 403 || res.status === 429) {
        console.log(`  rate-limited (${res.status}) on ${url} — backing off`);
        await sleep(3000 * attempt);
        continue;
      }
      return false; // 404 etc — definitive
    } catch (e) {
      await sleep(1000 * attempt);
    }
  }
  return 'blocked';
}

// Nintendo's own site search (Algolia). The search-only credentials are
// public — they ship in nintendo.com's frontend JS — but they rotate, so
// discover them from the site at runtime with hardcoded values as fallback.
const ALGOLIA_FALLBACK = { app: 'U3B6GR4UA3', key: 'a29c6927638bfd8cee23993e51e721c9' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

let algolia = null; // { app, key, indexes }

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    return res.ok ? await res.text() : '';
  } catch (e) { return ''; }
}

function extractCreds(src) {
  const m = src.match(/algoliasearch\(\s*["']([A-Z0-9]{8,12})["']\s*,\s*["']([a-f0-9]{16,64})["']/i)
    || src.match(/appId['"]?\s*[:=]\s*['"]([A-Z0-9]{8,12})['"][\s\S]{0,400}?apiKey['"]?\s*[:=]\s*['"]([a-f0-9]{16,64})['"]/i);
  return m ? { app: m[1], key: m[2] } : null;
}

async function listIndexes(creds) {
  try {
    const res = await fetch(`https://${creds.app.toLowerCase()}-dsn.algolia.net/1/indexes`, {
      headers: { 'x-algolia-application-id': creds.app, 'x-algolia-api-key': creds.key },
    });
    if (!res.ok) { console.log(`  algolia listIndexes: HTTP ${res.status}`); return []; }
    const d = await res.json();
    // Prefer real US-storefront indexes; skip testing/dev copies, sort
    // replicas (_asc/_des), and other locales (en_ca, en_gb, …)
    const names = (d.items || []).map(i => i.name)
      .filter(n => /store|product|game/i.test(n))
      .filter(n => !/testing|dev|staging|_asc|_des|price|release/i.test(n));
    const ordered = [
      ...names.filter(n => n === 'store_all_products'),
      ...names.filter(n => /en_us/i.test(n)),
      ...names.filter(n => !/en_[a-z]{2}|_ca\b|_gb\b|_mx\b|_br\b/i.test(n)),
    ];
    return [...new Set(ordered)].slice(0, 4);
  } catch (e) { return []; }
}

async function initAlgolia() {
  const candidates = [];
  const page = await fetchText('https://www.nintendo.com/us/search/');
  const inline = extractCreds(page);
  if (inline) candidates.push(inline);
  const scripts = [...page.matchAll(/src="([^"]+\.js[^"]*)"/g)]
    .map(m => m[1].startsWith('http') ? m[1] : 'https://www.nintendo.com' + m[1])
    .slice(0, 30);
  for (const s of scripts) {
    if (candidates.length) break;
    const creds = extractCreds(await fetchText(s));
    if (creds) candidates.push(creds);
  }
  candidates.push(ALGOLIA_FALLBACK);

  for (const creds of candidates) {
    const indexes = await listIndexes(creds);
    if (indexes.length) {
      console.log(`Algolia: app ${creds.app}, indexes: ${indexes.slice(0, 8).join(', ')}`);
      return { ...creds, indexes: indexes.slice(0, 8) };
    }
  }
  console.log('Algolia: no working credentials found — search fallback disabled');
  return null;
}

function hitUrl(hit) {
  const u = hit.url || (hit.slug ? `/store/products/${hit.slug}/` : '');
  if (!u) return null;
  if (/^https?:\/\//.test(u)) return u;
  return 'https://www.nintendo.com' + (u.startsWith('/us/') ? u : '/us' + u);
}

async function searchStore(title) {
  if (!algolia) return null;
  // "(DLC)" / "(Upgrade Pack)" markers hurt search relevance
  const query = String(title).replace(/\((dlc|upgrade pack)\)/gi, '').trim();
  for (const index of algolia.indexes) {
    try {
      const res = await fetch(`https://${algolia.app.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(index)}/query`, {
        method: 'POST',
        headers: {
          'x-algolia-application-id': algolia.app,
          'x-algolia-api-key': algolia.key,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, hitsPerPage: 5 }),
      });
      if (!res.ok) { console.log(`  algolia ${index}: HTTP ${res.status}`); continue; }
      const d = await res.json();
      const hits = (d.hits || []).filter(h => hitUrl(h) && /\/store\/products\//.test(hitUrl(h)));
      if (!hits.length) continue;
      const exact = hits.find(h => normTitle(h.title || '') === normTitle(title))
        || hits.find(h => normTitle(h.title || '') === normTitle(query));
      const hit = exact || hits[0];
      return { url: hitUrl(hit), exact: !!exact, hitTitle: hit.title || '' };
    } catch (e) {}
  }
  return null;
}

async function resolveTitle(title) {
  const fUrl = formulaUrl(title);
  let blocked = false;
  for (const url of candidates(title)) {
    const ok = await urlOk(url);
    if (ok === 'blocked') { blocked = true; continue; }
    if (ok) {
      return url === fUrl
        ? { url, status: 'verified' }
        : { url, status: 'verified — DIFFERS from formula, paste this into F' };
    }
  }

  // Slug guesses failed — ask Nintendo's own store search
  const found = await searchStore(title);
  if (found && await urlOk(found.url) === true) {
    return found.exact
      ? { url: found.url, status: 'verified via store search — paste this into F' }
      : { url: found.url, status: `search best match ("${found.hitTitle}") — VERIFY, then paste into F` };
  }

  if (blocked) return { url: fUrl, status: 'rate-limited — rerun workflow later' };
  return { url: fUrl, status: 'NOT FOUND — check manually' };
}

// Reuse verified results from a previous run so reruns only hit unresolved rows.
// Handles both the old 4-column and current 6-column CSV layouts.
function loadPrevious() {
  const prev = {};
  try {
    const lines = fs.readFileSync('eshop-urls.csv', 'utf8').split('\n').slice(1);
    const split = line => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(f => f.replace(/^"|"$/g, '').replace(/""/g, '"'));
    lines.filter(Boolean).forEach(line => {
      const f = split(line);
      const entry = f.length >= 6
        ? { title: f[1], url: f[2], id: f[3], cover: f[4], status: f[5] }
        : { title: f[1], url: f[2], id: '', cover: '', status: f[3] };
      if (entry.title && entry.status && entry.status.startsWith('verified')) {
        prev[entry.title] = { url: entry.url, status: entry.status, id: entry.id, cover: entry.cover };
      }
    });
  } catch (e) {}
  return prev;
}

// Scrape the Nintendo ID (nsuid) and cover art URL from a product page
async function fetchMeta(url) {
  const html = await fetchText(url);
  await sleep(250);
  const id = (html.match(/"nsuid"\s*:\s*"?(\d{10,20})"?/) || html.match(/"sku"\s*:\s*"([^"]+)"/) || [])[1] || '';
  const cover = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i) || [])[1] || '';
  return { id, cover };
}

(async () => {
  const gvizUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(TAB)}`;
  const res = await fetch(gvizUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${TAB}`);
  const text = await res.text();
  const json = JSON.parse(text.match(/setResponse\(([\s\S]*)\)\s*;?\s*$/)[1]);
  if (json.status === 'error') throw new Error(`Sheet error: ${TAB}`);

  const labels = json.table.cols.map(c => (c.label || '').toLowerCase().trim());
  console.log(`${TAB} headers:`, JSON.stringify(labels));
  let iTitle = labels.findIndex(h => h.includes('game title') || h === 'title');
  if (iTitle < 0) iTitle = TITLE_COL;

  // Keep one entry per sheet row (including blanks) so the CSV stays row-aligned
  const rows = json.table.rows.map(row => {
    const c = row.c || [];
    return c[iTitle] && c[iTitle].v != null ? String(c[iTitle].v).trim() : '';
  });
  console.log(`${rows.length} rows, ${rows.filter(Boolean).length} titles`);

  const previous = loadPrevious();
  console.log(`${Object.keys(previous).length} titles already verified in previous CSV`);

  algolia = await initAlgolia();

  const results = new Array(rows.length).fill(null);
  const cache = {}; // duplicate titles resolve once
  let cursor = 0;

  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const title = rows[i];
      if (!title) { results[i] = { url: '', status: '', id: '', cover: '' }; continue; }
      if (previous[title]) { results[i] = { ...previous[title] }; continue; }
      if (!cache[title]) cache[title] = resolveTitle(title);
      results[i] = { ...(await cache[title]) };
      console.log(`[${i + 1}/${rows.length}] ${title} → ${results[i].status}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Second pass: scrape Nintendo ID + cover art from every verified page
  // that doesn't have them yet (reruns skip pages already scraped).
  const metaCache = {};
  let metaCursor = 0;
  async function metaWorker() {
    while (metaCursor < rows.length) {
      const i = metaCursor++;
      const r = results[i];
      if (!r || !r.status || !r.status.startsWith('verified')) continue;
      if (r.id && r.cover) continue;
      if (!metaCache[r.url]) metaCache[r.url] = fetchMeta(r.url);
      const m = await metaCache[r.url];
      r.id = r.id || m.id;
      r.cover = r.cover || m.cover;
      console.log(`meta [${i + 1}/${rows.length}] ${rows[i]} → id: ${r.id || '—'}, cover: ${r.cover ? 'yes' : '—'}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, metaWorker));

  const esc = s => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const lines = ['sheet_row,title,eshop_url,nintendo_id,cover_url,status'];
  rows.forEach((title, i) => {
    const r = results[i];
    // +2: sheet rows are 1-based and row 1 is the header
    lines.push([i + 2, esc(title), r.url, r.id || '', r.cover || '', esc(r.status)].join(','));
  });
  fs.writeFileSync('eshop-urls.csv', lines.join('\n') + '\n');

  // Row-aligned TSV: copy the file contents, click F2 in the sheet, paste —
  // fills columns F (eShop URL), G (Nintendo ID), H (Cover URL) in one go.
  const tsv = rows.map((title, i) => {
    const r = results[i];
    const ok = r.status && r.status.startsWith('verified');
    return [ok ? r.url : '', ok ? r.id || '' : '', ok ? r.cover || '' : ''].join('\t');
  }).join('\n') + '\n';
  fs.writeFileSync('paste-into-F2.tsv', tsv);

  const verified = results.filter(r => r && r.status.startsWith('verified')).length;
  const withId    = results.filter(r => r && r.id).length;
  const withCover = results.filter(r => r && r.cover).length;
  const missing  = results.filter(r => r && r.status.startsWith('NOT FOUND')).length;
  const limited  = results.filter(r => r && r.status.startsWith('rate-limited')).length;
  console.log(`\nWrote eshop-urls.csv + paste-into-F2.tsv: ${verified} verified (${withId} with ID, ${withCover} with cover), ${missing} not found, ${limited} rate-limited`);
})().catch(err => { console.error(err); process.exit(1); });
