// Scrapes Carousell listings via their internal API (no browser needed).
// Carousell's mobile/web API is publicly accessible and not IP-restricted.
import fs from 'fs';

const USER = process.env.CAROUSELL_USER || 'im.bbloh';
const LIMIT = 30;

const headers = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-SG,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'referer': `https://www.carousell.sg/u/${USER}/`,
  'origin': 'https://www.carousell.sg',
};

function extractListings(data) {
  // Try various response shapes Carousell APIs use
  return data?.data?.listings
    || data?.listings
    || data?.results
    || data?.data?.results
    || data?.data?.getUserListings?.listings
    || [];
}

function parseItem(item) {
  const id = String(item.id || item.listing_id || item.listingId || '');
  const title = item.title || item.name || item.listing_title || '';
  const raw = item.price?.amount ?? item.price?.value ?? item.price ?? item.listing_price ?? null;
  const price = typeof raw === 'string'
    ? parseFloat(raw.replace(/[^0-9.]/g, '')) || null
    : typeof raw === 'number' ? (raw > 10000 ? raw / 100 : raw) : null;
  return id && title ? { id, title, price } : null;
}

async function tryEndpoint(url, opts = {}) {
  console.log(`Trying: ${url}`);
  try {
    const res = await fetch(url, { headers, ...opts });
    console.log(`  status: ${res.status}`);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) { console.log(`  non-JSON response`); return null; }
    return await res.json();
  } catch (e) {
    console.log(`  error: ${e.message}`);
    return null;
  }
}

const listings = [];

// Known Carousell API domains and endpoints
const endpoints = [
  `https://www.carousell.sg/api-service/listing/3/listings/of-user/?username=${USER}&limit=${LIMIT}&offset=0`,
  `https://www.carousell.sg/api/v2/users/${USER}/listings/?limit=${LIMIT}&offset=0`,
  `https://www.carousell.sg/flow/1/users/${USER}/listings/?limit=${LIMIT}&offset=0&sort_by=3`,
  `https://gateway.carousell.sg/api-service/listing/3/listings/of-user/?username=${USER}&limit=${LIMIT}&offset=0`,
];

for (const url of endpoints) {
  const data = await tryEndpoint(url);
  if (!data) continue;
  const items = extractListings(data);
  if (items.length) {
    console.log(`  found ${items.length} items!`);
    // Paginate
    let offset = LIMIT;
    for (const item of items) {
      const p = parseItem(item);
      if (p) listings.push({ ...p, url: `https://www.carousell.sg/p/${p.id}/`, href: `/p/${p.id}/`, text: p.title });
    }
    while (true) {
      const nextUrl = url.replace(`offset=0`, `offset=${offset}`);
      const nextData = await tryEndpoint(nextUrl);
      const nextItems = nextData ? extractListings(nextData) : [];
      if (!nextItems.length) break;
      for (const item of nextItems) {
        const p = parseItem(item);
        if (p) listings.push({ ...p, url: `https://www.carousell.sg/p/${p.id}/`, href: `/p/${p.id}/`, text: p.title });
      }
      offset += LIMIT;
      if (nextItems.length < LIMIT) break;
      await new Promise(r => setTimeout(r, 300));
    }
    break;
  }
  console.log(`  no listings in response`);
}

fs.writeFileSync('carousell-listings.json', JSON.stringify({ ts: Date.now(), user: USER, listings }, null, 1));
console.log(`Wrote carousell-listings.json with ${listings.length} listings`);

if (listings.length < 10) {
  console.error(`Only ${listings.length} listings — API may be blocked or endpoint changed`);
  process.exit(1);
}
