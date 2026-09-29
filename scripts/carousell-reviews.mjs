// Scrapes the Carousell profile's buyer reviews into reviews.json, which the
// site reads to fill its reviews strip.
//
// The site can't fetch these itself: Carousell serves no public feed and blocks
// cross-origin reads, so this runs in CI — same browser + stealth approach as
// carousell-scrape.mjs, which already gets through from GitHub Actions.
//
// Like the listing scrape, review text is React-rendered rather than present in
// the HTML, so the reliable source is Carousell's own JSON responses; the DOM is
// only a fallback for when those move.
//
// Exits non-zero when it finds nothing, so the workflow can keep the last good
// reviews.json rather than publishing an empty strip.
//
// Usage:
//   node scripts/carousell-reviews.mjs
//   CDP_URL=http://127.0.0.1:9222 node scripts/carousell-reviews.mjs   # attach
//     to your own logged-in Chrome if the headless run gets bot-blocked
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';

chromium.use(StealthPlugin());

const USER  = process.env.CAROUSELL_USER || 'im.bbloh';
const URL   = `https://www.carousell.sg/u/${USER}/?filter=0&sort=newest&tab=reviews`;
const OUT   = 'reviews.json';
const MAX   = Number(process.env.REVIEW_LIMIT || 24);   // the strip scrolls; no need for hundreds

const browser = process.env.CDP_URL
  ? await chromium.connectOverCDP(process.env.CDP_URL)
  : await chromium.launch({ headless: true });

const context = process.env.CDP_URL ? browser.contexts()[0] : await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 900 },
  locale: 'en-SG',
  timezoneId: 'Asia/Singapore',
});
const page = await context.newPage();

// ── Collect review-shaped objects out of any JSON the page fetches ───────────
const found = new Map();   // dedupe key → review

const clean = v => (v === null || v === undefined) ? '' : String(v).trim();

function pickName(o) {
  const u = o.author || o.reviewer || o.user || o.from_user || o.fromUser || o.buyer || {};
  return clean(u.username || u.name || u.display_name || u.displayName
            || o.username || o.reviewer_name || o.author_name);
}

function pickRating(o) {
  const r = o.rating ?? o.stars ?? o.score ?? o.rating_value ?? o.ratingValue;
  const n = typeof r === 'object' && r ? (r.value ?? r.score ?? r.amount) : r;
  const f = parseFloat(String(n).replace(/[^0-9.]/g, ''));
  return Number.isFinite(f) ? Math.max(1, Math.min(5, Math.round(f))) : null;
}

function pickText(o) {
  return clean(o.review || o.comment || o.content || o.body || o.text || o.message
            || o.review_text || o.reviewText || o.feedback);
}

function pickDate(o) {
  const d = o.created_at ?? o.createdAt ?? o.date ?? o.time_created ?? o.timestamp ?? o.reviewed_at;
  if (d === null || d === undefined || d === '') return '';
  // Carousell mixes seconds, milliseconds and pre-formatted strings.
  if (typeof d === 'number' || /^\d+$/.test(String(d))) {
    const n = Number(d);
    const ms = n < 1e12 ? n * 1000 : n;
    const dt = new Date(ms);
    if (isNaN(dt)) return '';
    return dt.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const dt = new Date(d);
  return isNaN(dt) ? clean(d)
    : dt.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function pickItem(o) {
  const l = o.listing || o.item || o.product || {};
  return clean(l.title || l.name || o.listing_title || o.item_title);
}

function walk(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 14) return;
  if (Array.isArray(obj)) { for (const v of obj) walk(v, depth + 1); return; }

  const text   = pickText(obj);
  const rating = pickRating(obj);
  // A review needs words and a score. Requiring both keeps listings, chat
  // messages and other commentable objects out of the set.
  if (text && text.length >= 4 && rating) {
    const r = {
      name:   pickName(obj),
      rating,
      text,
      date:   pickDate(obj),
      item:   pickItem(obj),
    };
    const key = (r.name + '|' + text.slice(0, 80)).toLowerCase();
    if (!found.has(key)) found.set(key, r);
  }
  for (const k of Object.keys(obj)) walk(obj[k], depth + 1);
}

page.on('response', async res => {
  if (!/carousell/i.test(res.url())) return;
  if (res.status() < 200 || res.status() >= 300) return;
  if (!(res.headers()['content-type'] || '').includes('json')) return;
  try {
    const body = await res.json().catch(() => null);
    if (body) walk(body);
  } catch (_) {}
});

console.log(`Loading ${URL} …`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

// Reviews paginate on scroll like the listings do.
for (let i = 0; i < 6 && found.size < MAX; i++) {
  await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
  await page.waitForTimeout(1800);
}

// Server-rendered state, for the case where the reviews arrive with the
// document instead of over XHR.
try {
  const embedded = await page.evaluate(() => {
    const out = [];
    const next = document.getElementById('__NEXT_DATA__');
    if (next) out.push(next.textContent);
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (/review/i.test(t) && /[[{]/.test(t) && t.length < 3e6) out.push(t);
    }
    return out;
  });
  for (const raw of embedded) {
    const m = raw.match(/[[{][\s\S]*[\]}]/);
    if (!m) continue;
    try { walk(JSON.parse(m[0])); } catch (_) {}
  }
} catch (_) {}

await browser.close();

const reviews = [...found.values()].slice(0, MAX);

if (!reviews.length) {
  console.error('No reviews found — leaving the existing reviews.json alone.');
  process.exit(1);
}

const rated = reviews.filter(r => r.rating);
const payload = {
  ts: Date.now(),
  source: URL,
  count: reviews.length,
  average: rated.length
    ? Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 10) / 10
    : null,
  reviews,
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n');
console.log(`Wrote ${OUT}: ${reviews.length} reviews, average ${payload.average}`);
