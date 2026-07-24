// Scrapes Carousell listings via their internal API (no browser needed).
// Tries GraphQL (ContainerGet) and several REST fallbacks.
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

function parseItem(item) {
  const id = String(item.id || item.listing_id || item.listingId || '');
  const title = item.title || item.name || item.listing_title || '';
  const raw = item.price?.amount ?? item.price?.value ?? item.price ?? item.listing_price ?? null;
  const price = typeof raw === 'string'
    ? parseFloat(raw.replace(/[^0-9.]/g, '')) || null
    : typeof raw === 'number' ? (raw > 10000 ? raw / 100 : raw) : null;
  return id && title ? { id, title, price } : null;
}

function extractListings(data) {
  return data?.data?.listings
    || data?.listings
    || data?.results
    || data?.data?.results
    || data?.data?.getUserListings?.listings
    || [];
}

// ── Walk a deeply nested GraphQL response to find listing-like objects ─────────
function walkForListings(obj, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 15) return out;
  if (Array.isArray(obj)) {
    for (const v of obj) walkForListings(v, out, depth + 1);
    return out;
  }
  const id = String(obj.id || obj.listingId || obj.listing_id || '');
  const title = obj.title || obj.name || obj.listing_title || obj.header || '';
  if (id && title && /^\d+$/.test(id)) {
    out.push(obj);
  }
  for (const v of Object.values(obj)) walkForListings(v, out, depth + 1);
  return out;
}

// ── GraphQL: ContainerGet (same query the web page uses) ──────────────────────
async function tryGraphQL(offset = 0) {
  // Carousell's ContainerGet query for a user profile page
  const query = `query ContainerGet($slug: String!) {
    containerGet(slug: $slug) {
      id
      widgets {
        ... on ListingsWidget {
          id
          listingCards {
            ... on ListingCard {
              id
              title
              price { amount }
              listingUrl
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;

  const variables = { slug: `/u/${USER}/` };
  const body = JSON.stringify({ query, variables });
  const url = 'https://www.carousell.sg/ds/';
  console.log(`Trying GraphQL ContainerGet (offset=${offset}): ${url}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body,
    });
    console.log(`  status: ${res.status}`);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) { console.log('  non-JSON'); return null; }
    return await res.json();
  } catch (e) {
    console.log(`  error: ${e.message}`);
    return null;
  }
}

// ── GraphQL: GetUserListings (the dedicated listings query) ───────────────────
async function tryGraphQLListings(cursor = null) {
  const query = `query GetUserProfileListings($username: String!, $first: Int, $after: String) {
    user(username: $username) {
      listings(first: $first, after: $after) {
        edges {
          node {
            id
            title
            price { amount }
            listingUrl
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
  const variables = { username: USER, first: LIMIT, ...(cursor ? { after: cursor } : {}) };
  const body = JSON.stringify({ query, variables });
  const url = 'https://www.carousell.sg/ds/';
  console.log(`Trying GraphQL GetUserProfileListings (cursor=${cursor})`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body,
    });
    console.log(`  status: ${res.status}`);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) { console.log('  non-JSON'); return null; }
    return await res.json();
  } catch (e) {
    console.log(`  error: ${e.message}`);
    return null;
  }
}

// ── Also try ContainerGet as GET request (as browser does) ───────────────────
async function tryGraphQLGet() {
  const query = encodeURIComponent(
    `query ContainerGet($slug: String!) { containerGet(slug: $slug) { id widgets { __typename } } }`
  );
  const vars = encodeURIComponent(JSON.stringify({ slug: `/u/${USER}/` }));
  const url = `https://www.carousell.sg/ds/?query=query%20ContainerGet&variables=${vars}`;
  return tryEndpoint(url);
}

// ── REST: the actual endpoint the profile page itself calls ──────────────────
// POST .../ds/search/search/3.3/username/{user}/products/ — confirmed working
// unauthenticated (logged-out incognito) via live DevTools inspection. Pagination
// is a server-issued opaque "session" cursor: the first request seeds an empty
// session, each response's data.session is echoed back as the next request's
// session until data.results comes back empty.
async function tryProductsSearch(session = '') {
  const path = `/search/3.3/username/${USER}/products/`;
  const url = `https://www.carousell.sg/ds/search${path}?_path=${encodeURIComponent(path)}&l=en`;
  const body = JSON.stringify({
    count: 20,
    countryId: '1880251', // Singapore
    filters: [],
    isPreviewPage: false,
    locale: 'en',
    query: null,
    session,
    sortParam: { ascending: { value: false }, fieldName: 'time_created' },
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    });
    console.log(`  products search status: ${res.status}`);
    if (!res.ok) {
      console.log(`  server: ${res.headers.get('server')}, cf-ray: ${res.headers.get('cf-ray')}, cf-mitigated: ${res.headers.get('cf-mitigated')}`);
      const text = await res.text().catch(() => '');
      console.log(`  body (first 500 chars): ${text.slice(0, 500)}`);
      return null;
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) { console.log('  non-JSON'); return null; }
    return await res.json();
  } catch (e) {
    console.log(`  error: ${e.message}`);
    return null;
  }
}

const listings = [];
const seen = new Set();

function addListing(id, title, price, href) {
  if (seen.has(id)) return;
  seen.add(id);
  listings.push({
    id,
    title,
    price,
    url: `https://www.carousell.sg/p/${id}/`,
    href: href || `/p/${id}/`,
    text: title,
  });
}

// ── 0. Try REST products search (the real endpoint the profile page uses) ────
let gqlWorked = false;
{
  let session = '';
  let page = 0;
  while (page < 30) {
    const data = await tryProductsSearch(session);
    const results = data?.data?.results || [];
    if (!results.length) break;
    gqlWorked = true;
    for (const r of results) {
      const c = r.listingCard;
      if (!c || !c.id) continue;
      const id = String(c.id);
      const title = c.title || '';
      const raw = c.price;
      const price = typeof raw === 'string' ? parseFloat(raw.replace(/[^0-9.]/g, '')) || null : null;
      if (id && title) addListing(id, title, price, `/p/${id}/`);
    }
    const nextSession = data?.data?.session;
    if (!nextSession || nextSession === session) break;
    session = nextSession;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }
  if (gqlWorked) console.log(`REST products search worked: ${listings.length} listings so far`);
}

// ── 1. Try GraphQL POST (GetUserProfileListings) ──────────────────────────────
if (!gqlWorked) {
  let cursor = null;
  let page = 0;
  while (page < 20) {
    const data = await tryGraphQLListings(cursor);
    if (!data) break;
    const edges = data?.data?.user?.listings?.edges || [];
    if (edges.length) {
      gqlWorked = true;
      for (const { node } of edges) {
        const id = String(node.id || '');
        const title = node.title || '';
        const price = node.price?.amount != null ? parseFloat(node.price.amount) : null;
        const href = node.listingUrl || `/p/${id}/`;
        if (id && title) addListing(id, title, price, href);
      }
      const pi = data?.data?.user?.listings?.pageInfo;
      if (!pi?.hasNextPage) break;
      cursor = pi.endCursor;
      page++;
      await new Promise(r => setTimeout(r, 300));
    } else {
      // Walk the response for any listing-like objects
      const found = walkForListings(data);
      if (found.length) {
        gqlWorked = true;
        for (const item of found) {
          const p = parseItem(item);
          if (p) addListing(p.id, p.title, p.price, item.listingUrl || null);
        }
      }
      break;
    }
  }
}

// ── 2. Try GraphQL POST (ContainerGet) ───────────────────────────────────────
if (!gqlWorked) {
  const data = await tryGraphQL();
  if (data) {
    const found = walkForListings(data);
    if (found.length) {
      gqlWorked = true;
      for (const item of found) {
        const p = parseItem(item);
        if (p) addListing(p.id, p.title, p.price, item.listingUrl || null);
      }
    } else {
      console.log('  GraphQL ContainerGet returned no recognizable listings');
      console.log('  Response keys:', JSON.stringify(Object.keys(data?.data || {})));
    }
  }
}

// ── 3. REST fallbacks ─────────────────────────────────────────────────────────
if (!gqlWorked) {
  const restEndpoints = [
    `https://www.carousell.sg/api-service/listing/3/listings/of-user/?username=${USER}&limit=${LIMIT}&offset=0`,
    `https://www.carousell.sg/api/v2/users/${USER}/listings/?limit=${LIMIT}&offset=0`,
    `https://www.carousell.sg/flow/1/users/${USER}/listings/?limit=${LIMIT}&offset=0&sort_by=3`,
    `https://gateway.carousell.sg/api-service/listing/3/listings/of-user/?username=${USER}&limit=${LIMIT}&offset=0`,
  ];

  for (const url of restEndpoints) {
    const data = await tryEndpoint(url);
    if (!data) continue;
    const items = extractListings(data);
    if (items.length) {
      console.log(`  found ${items.length} items!`);
      for (const item of items) {
        const p = parseItem(item);
        if (p) addListing(p.id, p.title, p.price, null);
      }
      // Paginate
      let offset = LIMIT;
      while (true) {
        const nextUrl = url.replace(`offset=0`, `offset=${offset}`);
        const nextData = await tryEndpoint(nextUrl);
        const nextItems = nextData ? extractListings(nextData) : [];
        if (!nextItems.length) break;
        for (const item of nextItems) {
          const p = parseItem(item);
          if (p) addListing(p.id, p.title, p.price, null);
        }
        offset += LIMIT;
        if (nextItems.length < LIMIT) break;
        await new Promise(r => setTimeout(r, 300));
      }
      break;
    }
    console.log(`  no listings in response`);
  }
}

fs.writeFileSync('carousell-listings.json', JSON.stringify({ ts: Date.now(), user: USER, listings }, null, 1));
console.log(`Wrote carousell-listings.json with ${listings.length} listings`);

if (listings.length < 10) {
  console.error(`Only ${listings.length} listings — API may be blocked or endpoint changed`);
  process.exit(1);
}
