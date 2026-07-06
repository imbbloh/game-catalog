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
const CONCURRENCY = 6;

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

async function urlOk(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    // Nintendo 404 pages return 404; a good product page returns 200
    return res.status === 200 ? res.url : null;
  } catch (e) {
    return null;
  }
}

async function resolveTitle(title) {
  const fUrl = formulaUrl(title);
  for (const url of candidates(title)) {
    const ok = await urlOk(url);
    if (ok) {
      return url === fUrl
        ? { url, status: 'verified' }
        : { url, status: 'verified — DIFFERS from formula, paste this into F' };
    }
  }
  // Nothing verified — still emit the best guess, but flag it
  return { url: fUrl, status: 'NOT FOUND — check manually' };
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

  const results = new Array(rows.length).fill(null);
  const cache = {}; // duplicate titles resolve once
  let cursor = 0;

  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const title = rows[i];
      if (!title) { results[i] = { url: '', status: '' }; continue; }
      if (!cache[title]) cache[title] = resolveTitle(title);
      results[i] = await cache[title];
      console.log(`[${i + 1}/${rows.length}] ${title} → ${results[i].status}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const esc = s => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const lines = ['sheet_row,title,eshop_url,status'];
  rows.forEach((title, i) => {
    // +2: sheet rows are 1-based and row 1 is the header
    lines.push([i + 2, esc(title), results[i].url, esc(results[i].status)].join(','));
  });
  fs.writeFileSync('eshop-urls.csv', lines.join('\n') + '\n');

  const verified = results.filter(r => r && r.status === 'verified').length;
  const missing  = results.filter(r => r && r.status.startsWith('NOT FOUND')).length;
  console.log(`\nWrote eshop-urls.csv: ${verified} verified, ${missing} not found`);
})().catch(err => { console.error(err); process.exit(1); });
