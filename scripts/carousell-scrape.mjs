// Scrapes ALL listings from the Carousell profile into carousell-listings.json.
// The profile only serves ~20 listings per page load and hides the rest behind
// a "View more" button + infinite scroll, so this drives a real browser.
//
// Titles and prices are captured by intercepting Carousell's own API responses
// (DOM text is empty because cards are React-rendered without accessible text).
//
// Usage:
//   node scripts/carousell-scrape.mjs                 # launch headless Chromium
//   CDP_URL=http://127.0.0.1:9222 node scripts/...    # attach to YOUR logged-in
//     Chrome (start it with --remote-debugging-port=9222) — use this if the
//     headless run gets bot-blocked.
import { chromium } from 'playwright';
import fs from 'fs';

const USER = process.env.CAROUSELL_USER || 'im.bbloh';
const PROFILE_URL = `https://www.carousell.sg/u/${USER}/`;

const browser = process.env.CDP_URL
  ? await chromium.connectOverCDP(process.env.CDP_URL)
  : await chromium.launch({ headless: true });

const context = process.env.CDP_URL ? browser.contexts()[0] : await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

// ── Intercept API responses to extract title + price ─────────────────────────
const apiData = new Map(); // id → { title, price }

function walkObj(obj, out, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return;
  if (Array.isArray(obj)) { for (const v of obj) walkObj(v, out, depth + 1); return; }
  const id = String(obj.id || obj.listingId || obj.listing_id || '');
  const title = obj.title || obj.name || obj.listing_title || obj.header || '';
  const raw = obj.price ?? obj.listing_price ?? obj.priceTag ?? obj.price_cents;
  let price = null;
  if (typeof raw === 'number') price = raw > 1000 ? raw / 100 : raw; // cents guard
  else if (typeof raw === 'string') price = parseFloat(raw.replace(/[^0-9.]/g, '')) || null;
  else if (raw && typeof raw === 'object') {
    const v = raw.amount ?? raw.value ?? raw.figure ?? raw.display ?? '';
    price = parseFloat(String(v).replace(/[^0-9.]/g, '')) || null;
    if (price > 10000) price = price / 100; // cents guard
  }
  if (id && title) out.set(id, { title: String(title).trim(), price });
  for (const k of Object.keys(obj)) walkObj(obj[k], out, depth + 1);
}

page.on('response', async res => {
  const url = res.url();
  if (!/carousell/i.test(url)) return;
  if (res.status() < 200 || res.status() >= 300) return;
  const ct = res.headers()['content-type'] || '';
  if (!ct.includes('json')) return;
  try {
    const body = await res.json().catch(() => null);
    if (!body) return;
    walkObj(body, apiData);
  } catch (_) {}
});

console.log(`Loading ${PROFILE_URL} …`);
await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);

// ── Expand: click "View more" and scroll until all listings are loaded ────────
let prev = -1, stable = 0;
for (let round = 0; round < 300; round++) {
  const viewMore = page.locator('button:has-text("View more"), [role="button"]:has-text("View more")').first();
  const visible = await viewMore.isVisible().catch(() => false);
  if (visible) await viewMore.click().catch(() => {});
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(700);

  const count = await page.locator('a[href*="/p/"]').count();
  if (count === prev) {
    if (++stable >= 5 && !visible) break;
  } else {
    stable = 0;
  }
  prev = count;
  if (round % 10 === 0) console.log(`  round ${round}: ${count} listing links, ${apiData.size} from API`);
}

// ── Collect listing IDs from DOM links ────────────────────────────────────────
const domLinks = await page.$$eval('a[href*="/p/"]', as => as.map(a => ({
  href: a.getAttribute('href') || '',
  domText: (a.closest('li, article, [data-testid]')?.textContent || '').trim().slice(0, 600),
})));

const seen = new Set();
const listings = [];

for (const { href, domText } of domLinks) {
  const m = href.match(/\/p\/(?:[^/]*-)?(\d+)\/?/);
  if (!m) continue;
  const id = m[1];
  if (seen.has(id)) continue;
  seen.add(id);

  const api = apiData.get(id);

  // Price fallback: parse from DOM text if API didn't supply it
  let price = api?.price ?? null;
  if (price === null) {
    const prices = domText.match(/S\$\s?[\d,]+(?:\.\d{1,2})?/g);
    if (prices) price = parseFloat(prices[prices.length - 1].replace(/[^0-9.]/g, '')) || null;
  }

  listings.push({
    id,
    url: `https://www.carousell.sg/p/${id}/`,
    href,
    text: api?.title ?? domText.slice(0, 300),
    price,
  });
}

fs.writeFileSync('carousell-listings.json', JSON.stringify({ ts: Date.now(), user: USER, listings }, null, 1));
console.log(`Wrote carousell-listings.json with ${listings.length} listings`);
console.log(`API enriched: ${listings.filter(l => apiData.has(l.id)).length} / ${listings.length}`);

if (!process.env.CDP_URL) await browser.close();

if (listings.length < 30) {
  console.error(`Only ${listings.length} listings captured — likely bot-blocked or not fully expanded. ` +
    'Re-run attached to your logged-in Chrome: start Chrome with --remote-debugging-port=9222, then ' +
    'CDP_URL=http://127.0.0.1:9222 node scripts/carousell-scrape.mjs');
  process.exit(1);
}
