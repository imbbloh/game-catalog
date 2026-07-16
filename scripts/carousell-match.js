// Matches carousell-listings.json against the Google Sheet and produces
// paste-ready Carousell URL columns. Every matched row is always written —
// existing URLs are overwritten so stale/removed listings get updated.
//
// Outputs (all row-aligned to the sheet, blank line = no match):
//   carousell-urls-raw-data.tsv       → paste into the Carousell URL column of "Raw Data"
//   carousell-urls-digital-codes.tsv  → paste into the Carousell URL column of "Raw Data - Digital Codes"
//   carousell-urls.csv                → human-readable report of every match decision
const fs = require('fs');

const SHEET_ID = '1ly37Y9r-_q44Fp7DpfMVlo_8JdYPHCHwapA6kHy-msw';

// Sheet tabs: [tab, titleCol, priceCol, default carousell col (0-based)]
const TABS = {
  games: { tab: 'Raw Data',                 titleCol: 1, priceCol: 2, carousellCol: 9, platColFallback: 4 }, // J, Platform=E
  codes: { tab: 'Raw Data - Digital Codes', titleCol: 2, priceCol: 3, carousellCol: 8, platColFallback: -1 }, // platform col found dynamically via header search
};

// ── Normalization (mirrors the matching spec) ────────────────────────────────
const ROMAN  = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9', xi: '11', xii: '12', xiii: '13' };
const FILLER = new Set(['nintendo', 'switch', 'edition', 'the']);
const VARIANT = new Set(['bundle', 'expansion', 'pass', 'dlc', 'deluxe', 'ultimate', 'edition']);

function tokens(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[™®'’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^a-z0-9]+/).filter(Boolean)
    .map(t => ROMAN[t] || t)
    .filter(t => !FILLER.has(t));
}

const numSet = toks => {
  const nums = toks.filter(t => /^\d+$/.test(t));
  // Exclude bare numbers that are substrings of another token (e.g. "26" inside "2k26")
  return new Set(nums.filter(n => !toks.some(t => t !== n && t.includes(n))));
};
const setEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
}

// ── Listing name cleanup ─────────────────────────────────────────────────────
function cleanListingName(t) {
  t = String(t)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}✅❗️]/gu, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/PREORDER BONUS/gi, ' ');
  const seps = [/–/, / - Nintendo/i, /NS ?\d/i, / Switch \d/i, /Redemption/i, /\[/, /\(Upgrade/i, / - Digital/i];
  let cut = t.length;
  for (const re of seps) {
    const m = t.search(re);
    if (m >= 0 && m < cut) cut = m;
  }
  return t.slice(0, cut).replace(/\s+/g, ' ').trim();
}

function isCode(listing) {
  return /DIGITAL CODE/i.test(listing.text) || /redemption-game-code|digital-code/i.test(listing.href || '');
}

// ── Platform detection ────────────────────────────────────────────────────────
// Returns a canonical platform tag from a Carousell listing name
function listingPlatform(name) {
  const s = String(name).toLowerCase();
  if (/ps5|playstation\s*5/.test(s)) return 'ps5';
  if (/ps4|playstation\s*4/.test(s)) return 'ps4';
  if (/\bswitch\b|nintendo\s*switch|\bns\b|\bns2\b/.test(s)) return 'switch';
  return null;
}

// Returns a Set of canonical platform tags from the sheet Platform column value
// Handles combined values like "PS4 & PS5" → Set{'ps4','ps5'}
function sheetPlatforms(val) {
  const s = String(val || '').toLowerCase();
  const out = new Set();
  if (/ps5/.test(s)) out.add('ps5');
  if (/ps4/.test(s)) out.add('ps4');
  if (/switch/.test(s)) out.add('switch');
  return out;
}

// Compatible if listing platform is unknown/undetected AND sheet has a platform set, or listing platform is in sheet set.
// If sheet has no platform (blank), the row is skipped (platform is required).
function platformsCompatible(lp, spSet) {
  if (!spSet || spSet.size === 0) return false;  // blank sheet platform → skip row
  if (!lp) return true;                           // listing platform undetectable → allow
  return spSet.has(lp);
}

// ── Matching ─────────────────────────────────────────────────────────────────
function bestMatch(sheetTitle, sheetPrice, sheetPlat, candidates) {
  const st = tokens(cleanListingName(sheetTitle));
  const sn = numSet(st);
  const stSet = new Set(st);

  const eligible = [];
  for (const c of candidates) {
    if (/\bSOLD\b/i.test(c.text)) continue;                       // sold items
    const lp = listingPlatform(c.text);  // use original text — platform info is often after the separator
    if (!platformsCompatible(lp, sheetPlat)) continue;            // platform mismatch
    const lt = c.toks;
    if (!setEq(sn, numSet(lt))) continue;                         // numeric guard (sequels)
    const ltSet = new Set(lt);
    const exact = st.length === lt.length && st.every((t, i) => t === lt[i]);
    const contained = [...stSet].every(t => ltSet.has(t));
    const jac = jaccard(st, lt);
    if (!(exact || contained || jac >= 0.82)) continue;
    let extra = 0;
    for (const t of ltSet) if (!stSet.has(t)) extra += VARIANT.has(t) ? 1.5 : 1;
    eligible.push({ c, exact, extra, jac });
  }

  eligible.sort((a, b) =>
    (b.exact - a.exact)
    || (a.extra - b.extra)
    || (priceDiff(a.c, sheetPrice) - priceDiff(b.c, sheetPrice))
    || (a.c.name.length - b.c.name.length));
  return eligible[0] || null;
}

function priceDiff(c, sheetPrice) {
  if (c.price == null || sheetPrice == null) return 1e9;
  return Math.abs(c.price - sheetPrice);
}

// ── Sheet reader ─────────────────────────────────────────────────────────────
async function fetchTab(tabName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tabName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${tabName}`);
  const text = await res.text();
  const json = JSON.parse(text.match(/setResponse\(([\s\S]*)\)\s*;?\s*$/)[1]);
  if (json.status === 'error') throw new Error(`Sheet error: ${tabName}`);
  return json.table;
}

const cell = (row, i) => {
  const c = row.c || [];
  return c[i] && c[i].v !== null && c[i].v !== undefined ? String(c[i].v).trim() : '';
};

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const { listings } = JSON.parse(fs.readFileSync('carousell-listings.json', 'utf8'));
  console.log(`${listings.length} Carousell listings loaded`);

  const pool = { games: [], codes: [] };
  for (const l of listings) {
    const name = cleanListingName(l.text);
    if (!name) continue;
    const entry = { ...l, name, toks: tokens(name) };
    (isCode(l) ? pool.codes : pool.games).push(entry);
  }
  console.log(`Classified: ${pool.games.length} game listings, ${pool.codes.length} digital-code listings`);

  const report = ['sheet,row,title,status,carousell_url,listing_title'];
  const esc = s => /[",\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : s;

  for (const [kind, cfg] of Object.entries(TABS)) {
    const table = await fetchTab(cfg.tab);
    const labels = table.cols.map(c => (c.label || '').toLowerCase().trim());
    let cCol = labels.findIndex(h => h.includes('carousell'));
    if (cCol < 0) cCol = cfg.carousellCol;
    console.log(`${cfg.tab}: carousell column index ${cCol} (${labels[cCol] || 'no header — add one!'})`);

    let platCol = labels.findIndex(h => h.includes('platform'));
    if (platCol < 0) platCol = cfg.platColFallback ?? -1;
    console.log(`${cfg.tab}: platform column index ${platCol} (${platCol >= 0 ? (labels[platCol] || 'col '+platCol) : 'not found — no platform filtering'})`);

    const out = [];
    let matched = 0, unmatched = 0;
    table.rows.forEach((row, i) => {
      const title = cell(row, cfg.titleCol);
      const existing = cell(row, cCol);
      if (!title) { out.push(''); return; }
      const price = parseFloat(cell(row, cfg.priceCol).replace(/[^0-9.]/g, '')) || null;
      const plat = platCol >= 0 ? sheetPlatforms(cell(row, platCol)) : new Set();
      const m = bestMatch(title, price, plat, pool[kind]);
      if (m) {
        out.push(m.c.url);
        matched++;
        report.push([cfg.tab, i + 2, esc(title), m.exact ? 'matched (exact)' : 'matched — VERIFY', m.c.url, esc(m.c.name)].join(','));
      } else {
        out.push('');
        unmatched++;
        report.push([cfg.tab, i + 2, esc(title), 'no match', '', ''].join(','));
      }
    });

    const file = kind === 'games' ? 'carousell-urls-raw-data.tsv' : 'carousell-urls-digital-codes.tsv';
    fs.writeFileSync(file, out.join('\n') + '\n');
    console.log(`${cfg.tab}: ${matched} matched, ${unmatched} unmatched → ${file}`);
  }

  fs.writeFileSync('carousell-urls.csv', report.join('\n') + '\n');
  console.log('Wrote carousell-urls.csv report');

  // Machine-readable matches for the Apps Script daily sync.
  // Keyed by 1-based sheet row number so duplicate titles don't overwrite each other.
  const matches = { ts: Date.now(), games: {}, codes: {} };
  for (const [kind, cfg] of Object.entries(TABS)) {
    const table = await fetchTab(cfg.tab);
    const labels2 = table.cols.map(c => (c.label || '').toLowerCase().trim());
    let platCol2 = labels2.findIndex(h => h.includes('platform'));
    if (platCol2 < 0) platCol2 = cfg.platColFallback ?? -1;
    table.rows.forEach((row, i) => {
      const title = cell(row, cfg.titleCol);
      if (!title) return;
      const price = parseFloat(cell(row, cfg.priceCol).replace(/[^0-9.]/g, '')) || null;
      const plat = platCol2 >= 0 ? sheetPlatforms(cell(row, platCol2)) : new Set();
      const m = bestMatch(title, price, plat, pool[kind]);
      if (m) matches[kind][String(i + 2)] = { url: m.c.url, price: m.c.price ?? null };
    });
  }
  fs.writeFileSync('carousell-matches.json', JSON.stringify(matches, null, 1));
  console.log(`Wrote carousell-matches.json (${Object.keys(matches.games).length} games, ${Object.keys(matches.codes).length} codes)`);
})().catch(err => { console.error(err); process.exit(1); });
