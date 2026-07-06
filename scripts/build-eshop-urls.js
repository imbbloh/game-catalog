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

function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\(switch 2 edition\)/g, '')
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function candidates(title) {
  const slug = slugify(title);
  const isSwitch2 = /switch\s*2/i.test(title);
  const list = isSwitch2
    ? [`${slug}-switch-2/`, `${slug}-switch/`, `${slug}/`]
    : [`${slug}-switch/`, `${slug}-switch-2/`, `${slug}/`];
  return list.map(p => `https://www.nintendo.com/us/store/products/${p}`);
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
  for (const url of candidates(title)) {
    const ok = await urlOk(url);
    if (ok) return { url, status: 'verified' };
  }
  // Nothing verified — still emit the best guess, but flag it
  return { url: candidates(title)[0], status: 'NOT FOUND — check manually' };
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
