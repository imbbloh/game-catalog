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

async function fetchListings() {
  const listings = [];
  let offset = 0;
  let hasMore = true;

  // Try the public profile API endpoint
  while (hasMore) {
    const url = `https://api.carousell.sg/flow/1/users/${USER}/listings/?limit=${LIMIT}&offset=${offset}&sort_by=3`;
    console.log(`Fetching offset ${offset}...`);

    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.log(`API returned ${res.status} at offset ${offset}`);
      break;
    }

    const data = await res.json();
    const items = data?.data?.listings || data?.listings || data?.results || [];

    if (!items.length) {
      hasMore = false;
      break;
    }

    for (const item of items) {
      const id = String(item.id || item.listing_id || item.listingId || '');
      const title = item.title || item.name || '';
      const price = item.price?.amount ?? item.price ?? item.listing_price ?? null;
      const priceParsed = typeof price === 'string'
        ? parseFloat(price.replace(/[^0-9.]/g, '')) || null
        : typeof price === 'number' ? price : null;

      if (id && title) {
        listings.push({
          id,
          url: `https://www.carousell.sg/p/${id}/`,
          href: `/p/${id}/`,
          text: title,
          price: priceParsed,
        });
      }
    }

    console.log(`  got ${items.length} items (total: ${listings.length})`);
    offset += LIMIT;

    if (items.length < LIMIT) hasMore = false;
    await new Promise(r => setTimeout(r, 300));
  }

  return listings;
}

async function tryGraphQL() {
  // Carousell also has a GraphQL endpoint used by the web app
  const url = 'https://api.carousell.sg/graphql/query/';
  const body = JSON.stringify({
    operationName: 'GetUserListings',
    variables: { username: USER, limit: LIMIT, offset: 0, filters: [] },
    query: `query GetUserListings($username: String!, $limit: Int, $offset: Int) {
      user(username: $username) {
        listings(limit: $limit, offset: $offset) {
          edges { node { id title price { amount } } }
          pageInfo { hasNextPage }
        }
      }
    }`,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data?.data?.user?.listings?.edges || null;
}

console.log(`Fetching listings for ${USER} via Carousell API...`);

let listings = await fetchListings();

if (!listings.length) {
  console.log('REST API returned 0 — trying GraphQL...');
  const gql = await tryGraphQL();
  if (gql?.length) {
    for (const { node } of gql) {
      listings.push({
        id: String(node.id),
        url: `https://www.carousell.sg/p/${node.id}/`,
        href: `/p/${node.id}/`,
        text: node.title,
        price: node.price?.amount ?? null,
      });
    }
  }
}

fs.writeFileSync('carousell-listings.json', JSON.stringify({ ts: Date.now(), user: USER, listings }, null, 1));
console.log(`Wrote carousell-listings.json with ${listings.length} listings`);

if (listings.length < 10) {
  console.error(`Only ${listings.length} listings — API may be blocked or endpoint changed`);
  process.exit(1);
}
