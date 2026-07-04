// Builds games.json — a static snapshot of the Google Sheet catalog.
// Run by .github/workflows/catalog.yml every 15 minutes so the website can
// load the whole catalog in one same-origin request instead of three slow
// Google gviz requests.
const fs = require('fs');

const SHEET_ID = '1ly37Y9r-_q44Fp7DpfMVlo_8JdYPHCHwapA6kHy-msw';

const SHEET_TABS = [
  { tab: 'Nintendo Switch Games',  type: 'ns' },
  { tab: 'Playstation Games',      type: 'ps' },
  { tab: 'Digital Codes - Switch', type: 'code' },
];

// Same column rules as index.html: E = store URL, F = eShop title, I = cover.
const URL_COL   = 4;
const ESHOP_COL = 5;
const COVER_COL = 8;

const IMG_URL_RE  = /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i;
const IMG_HOST_RE = /^https?:\/\/(image\.api\.playstation\.com|assets\.nintendo\.com|img-eshop\.cdn\.nintendo\.net|lh\d\.googleusercontent\.com|drive\.google\.com)\//i;

async function fetchTab(tabName, type) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tabName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${tabName}`);
  const text = await res.text();
  const json = JSON.parse(text.match(/setResponse\(([\s\S]*)\)\s*;?\s*$/)[1]);
  if (json.status === 'error') throw new Error(`Sheet error: ${tabName}`);
  const table = json.table;

  let rows    = table.rows;
  let headers = table.cols.map(c => (c.label || '').toLowerCase().trim());
  if (headers.join('') === '' && rows.length) {
    headers = (rows[0].c || []).map(c => c && c.v != null ? String(c.v).toLowerCase().trim() : '');
    rows = rows.slice(1);
  }

  const colIdx = keywords => headers.findIndex(h => keywords.some(k => h.includes(k)));
  const idx = {
    title:    colIdx(['game title', 'title', 'game name', 'game', 'name']),
    normal:   colIdx(['normal']),
    premium:  colIdx(['premium']),
    price:    colIdx(['price', 'cost', 'amount']),
    platform: colIdx(['platform']),
    url:      URL_COL,
    eshop:    ESHOP_COL,
    cover:    colIdx(['cover url', 'cover image', 'cover', 'image url', 'image', 'thumbnail']),
  };
  if (idx.cover < 0) idx.cover = COVER_COL;

  const val = (row, i) => {
    if (i < 0 || !row.c || !row.c[i]) return '';
    const v = row.c[i].v;
    return v !== null && v !== undefined ? String(v) : '';
  };
  const toPrice = v => {
    const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
    return isNaN(n) ? null : n;
  };
  const rowCover = row => {
    const v = val(row, idx.cover).trim();
    if (/^https?:\/\//i.test(v)) return v;
    const cells = row.c || [];
    for (let i = 0; i < cells.length; i++) {
      if (i === idx.url || i === idx.title) continue;
      const s = cells[i] && cells[i].v != null ? String(cells[i].v).trim() : '';
      if (IMG_URL_RE.test(s) || IMG_HOST_RE.test(s)) return s;
    }
    return '';
  };

  return rows
    .filter(row => row.c && idx.title >= 0 && row.c[idx.title] && row.c[idx.title].v)
    .map(row => ({
      title:        val(row, idx.title).trim(),
      normalPrice:  toPrice(val(row, idx.normal)),
      premiumPrice: toPrice(val(row, idx.premium)),
      codePrice:    toPrice(val(row, idx.price)),
      platform:     val(row, idx.platform).trim(),
      storeUrl:     val(row, idx.url).trim(),
      eshopTitle:   val(row, idx.eshop).trim(),
      coverUrl:     rowCover(row),
      type,
    }))
    .filter(g => g.title.length > 0);
}

// "Raw Data" tab: primary source of cover art. Headers are
// Timestamp, Game Title, ..., Cover URL — so title is column B (index 1)
// and cover is column I (index 8). Matched to games by normalized title.
const RAW_TAB = 'Raw Data';
const RAW_TITLE_COL = 1;
const RAW_COVER_COL = 8;

const normTitle = t => String(t).toLowerCase().replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();

async function fetchRawCovers() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(RAW_TAB)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${RAW_TAB}`);
  const text = await res.text();
  const json = JSON.parse(text.match(/setResponse\(([\s\S]*)\)\s*;?\s*$/)[1]);
  if (json.status === 'error') throw new Error(`Sheet error: ${RAW_TAB}`);

  const labels = json.table.cols.map(c => (c.label || '').toLowerCase().trim());
  console.log(`${RAW_TAB} headers:`, JSON.stringify(labels));

  // Prefer header detection; fall back to the known fixed positions
  let iTitle = labels.findIndex(h => h.includes('game title') || h === 'title');
  let iCover = labels.findIndex(h => h.includes('cover'));
  if (iTitle < 0) iTitle = RAW_TITLE_COL;
  if (iCover < 0) iCover = RAW_COVER_COL;

  const covers = {};
  json.table.rows.forEach(row => {
    const c = row.c || [];
    const key   = c[iTitle] && c[iTitle].v != null ? String(c[iTitle].v) : '';
    const cover = c[iCover] && c[iCover].v != null ? String(c[iCover].v).trim() : '';
    if (key && /^https?:\/\//i.test(cover)) covers[normTitle(key)] = cover;
  });
  console.log(`${RAW_TAB}: ${Object.keys(covers).length} cover URLs`);
  return covers;
}

(async () => {
  const [results, rawResult] = await Promise.all([
    Promise.allSettled(SHEET_TABS.map(s => fetchTab(s.tab, s.type))),
    fetchRawCovers().catch(err => { console.warn('Raw Data error:', err.message); return {}; }),
  ]);
  const games = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const errs  = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (errs.length) console.warn('Sheet errors:', errs.join(' | '));

  // Raw Data covers take priority; per-tab column I stays as fallback
  let rawHits = 0;
  games.forEach(g => {
    const c = rawResult[normTitle(g.title)] || rawResult[normTitle(g.eshopTitle)];
    if (c) { g.coverUrl = c; rawHits++; }
  });
  console.log(`Covers from ${RAW_TAB}: ${rawHits}/${games.length} games`);
  if (!games.length) {
    console.error('No games parsed — refusing to write an empty games.json');
    process.exit(1);
  }
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync('games.json', 'utf8')); } catch (e) {}
  if (prev && JSON.stringify(prev.games) === JSON.stringify(games)) {
    console.log(`games.json unchanged (${games.length} games) — skipping write`);
    return;
  }
  fs.writeFileSync('games.json', JSON.stringify({ ts: Date.now(), games }));
  console.log(`Wrote games.json with ${games.length} games (${errs.length} tab errors)`);
})().catch(err => { console.error(err); process.exit(1); });
