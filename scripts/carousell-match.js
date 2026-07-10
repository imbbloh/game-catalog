// Matches carousell-listings.json against the Google Sheet and produces
// paste-ready Carousell URL columns. Rows whose Carousell URL cell is already
// filled are kept as-is (skip); only blank cells get a scraped match.
//
// Outputs (all row-aligned to the sheet, blank line = no match):
//   carousell-urls-raw-data.tsv       → paste into the Carousell URL column of "Raw Data"
//   carousell-urls-digital-codes.tsv  → paste into the Carousell URL column of "Raw Data - Digital Codes"
//   carousell-urls.csv                → human-readable report of every match decision
const fs = require('fs');

const SHEET_ID = '1ly37Y9r-_q44Fp7DpfMVlo_8JdYPHCHwapA6kHy-msw';

// Sheet tabs: [tab, titleCol, priceCol, default carousell col (0-based)]
const TABS = {
  games: { tab: 'Raw Data',                 titleCol: 1, priceCol: 2, carousellCol: 9 }, // J
  codes: { tab: 'Raw Data - Digital Codes', titleCol: 2, priceCol: 3, carousellCol: 8 }, // I
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

const numSet = toks => new Set(toks.filter(t => /^\d+$/.test(t)));
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
  const seps = [/–/, / - Nintendo/i, /NS ?1/, /Redemption/i, /\[/, /\(Upgrade/i, / - Digital/i];
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

// ── Matching ─────────────────────────────────────────────────────────────────
function bestMatch(sheetTitle, sheetPrice, candidates) {
  const st = tokens(sheetTitle);
  const sn = numSet(st);
  const stSet = new Set(st);

  const eligible = [];
  for (const c of candidates) {
    if (/\bSOLD\b/i.test(c.text)) continue;                       // sold items
    if (/\bps[45]?\b|playstation/i.test(c.name)) continue;        // wrong platform
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

    const out = [];
    let matched = 0, skipped = 0, unmatched = 0;
    table.rows.forEach((row, i) => {
      const title = cell(row, cfg.titleCol);
      const existing = cell(row, cCol);
      if (!title) { out.push(''); return; }
      if (/^https?:\/\//i.test(existing)) {               // already filled → skip, keep as-is
        out.push(existing);
        skipped++;
        return;
      }
      const price = parseFloat(cell(row, cfg.priceCol).replace(/[^0-9.]/g, '')) || null;
      const m = bestMatch(title, price, pool[kind]);
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
    console.log(`${cfg.tab}: ${matched} matched, ${skipped} already filled (kept), ${unmatched} unmatched → ${file}`);
  }

  fs.writeFileSync('carousell-urls.csv', report.join('\n') + '\n');
  console.log('Wrote carousell-urls.csv report');
})().catch(err => { console.error(err); process.exit(1); });
