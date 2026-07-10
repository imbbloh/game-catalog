// Scrapes ALL listings from the Carousell profile into carousell-listings.json.
// The profile only serves ~20 listings per page load and hides the rest behind
// a "View more" button + infinite scroll, so this drives a real browser.
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

console.log(`Loading ${PROFILE_URL} …`);
await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);

// Expand until the listing count stops growing and no "View more" remains
let prev = -1, stable = 0;
for (let round = 0; round < 300; round++) {
  const viewMore = page.locator('button:has-text("View more"), [role="button"]:has-text("View more")').first();
  if (await viewMore.isVisible().catch(() => false)) {
    await viewMore.click().catch(() => {});
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);

  const count = await page.locator('a[href*="/p/"]').count();
  if (count === prev) {
    if (++stable >= 5 && !(await viewMore.isVisible().catch(() => false))) break;
  } else {
    stable = 0;
  }
  prev = count;
  if (round % 10 === 0) console.log(`  round ${round}: ${count} listing links`);
}

const raw = await page.$$eval('a[href*="/p/"]', as => as.map(a => ({
  href: a.getAttribute('href') || '',
  text: (a.closest('[data-testid], article, li, div')?.textContent || a.textContent || '').trim(),
})));

const seen = {};
const listings = [];
for (const { href, text } of raw) {
  const m = href.match(/\/p\/(?:[^/]*-)?(\d+)\/?/);
  if (!m) continue;
  const id = m[1];
  if (seen[id]) continue;
  seen[id] = true;
  const prices = text.match(/S\$\s?[\d,]+(?:\.\d{1,2})?/g);
  listings.push({
    id,
    url: `https://www.carousell.sg/p/${id}/`,
    href,
    text: text.slice(0, 500),
    price: prices ? parseFloat(prices[prices.length - 1].replace(/[^0-9.]/g, '')) : null,
  });
}

fs.writeFileSync('carousell-listings.json', JSON.stringify({ ts: Date.now(), user: USER, listings }, null, 1));
console.log(`Wrote carousell-listings.json with ${listings.length} listings`);
if (!process.env.CDP_URL) await browser.close();

if (listings.length < 30) {
  console.error(`Only ${listings.length} listings captured — likely bot-blocked or not fully expanded. ` +
    'Re-run attached to your logged-in Chrome: start Chrome with --remote-debugging-port=9222, then ' +
    'CDP_URL=http://127.0.0.1:9222 node scripts/carousell-scrape.mjs');
  process.exit(1);
}
