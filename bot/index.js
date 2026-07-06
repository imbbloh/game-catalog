const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN      = process.env.BOT_TOKEN;
const WEBHOOK_URL    = process.env.WEBHOOK_URL;
const SHEET_ID       = '1ly37Y9r-_q44Fp7DpfMVlo_8JdYPHCHwapA6kHy-msw';
const CAROUSELL_USER = 'im.bbloh';
const PORT           = process.env.PORT || 3000;

// ── Telegram bot ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN);
bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('Game Catalog Bot is running.'));

// ── Sheet data via public gviz URL (no auth needed) ───────────────────────────
// Mirrors the website's parsing: column E = store URL, F = eShop title,
// I = cover URL (with a row-scan fallback for image-looking URLs).
const SHEET_TABS = [
  { tab: 'Raw Data',               type: 'ns' },
  { tab: 'Playstation Games',      type: 'ps' },
  { tab: 'Digital Codes - Switch', type: 'code' },
];

const URL_COL   = 5; // column F (Raw Data)
const ESHOP_COL = 5;
const COVER_COL = 8; // column I

const IMG_URL_RE  = /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i;
const IMG_HOST_RE = /^https?:\/\/(image\.api\.playstation\.com|assets\.nintendo\.com|img-eshop\.cdn\.nintendo\.net|lh\d\.googleusercontent\.com|drive\.google\.com)\//i;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function fetchSheetTab(tabName, type) {
  const url  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tabName)}`;
  const text = await httpGet(url);
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

// In-memory catalog cache with stale-while-revalidate: requests are served
// instantly from cache; a background refresh runs when it's older than 5 min.
let catalogCache = null;
let catalogTime  = 0;
let refreshing   = null;
const CATALOG_TTL = 5 * 60 * 1000;

function refreshCatalog() {
  if (refreshing) return refreshing;
  refreshing = Promise.allSettled(SHEET_TABS.map(s => fetchSheetTab(s.tab, s.type)))
    .then(results => {
      const games = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
      const errs  = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
      if (errs.length) console.warn('Sheet errors:', errs.join(' | '));
      if (games.length || !catalogCache) {
        catalogCache = games;
        catalogTime  = Date.now();
      }
      return catalogCache;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function getCatalog() {
  if (!catalogCache) return refreshCatalog();
  if (Date.now() - catalogTime > CATALOG_TTL) refreshCatalog(); // refresh in background
  return catalogCache;
}

async function getGames() {
  const catalog = await getCatalog();
  return catalog.map(g => ({
    title:    g.title,
    normal:   g.normalPrice !== null ? g.normalPrice : g.codePrice,
    premium:  g.premiumPrice,
    platform: g.platform,
    url:      g.storeUrl,
    cover:    g.coverUrl,
    type:     g.type,
  }));
}

// ── Public JSON API for the website ───────────────────────────────────────────
app.get('/api/games', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const games = await getCatalog();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ts: catalogTime, games });
  } catch (err) {
    console.error('API error:', err);
    res.status(502).json({ error: 'Could not load catalog' });
  }
});

// Warm the cache on boot and keep the Render instance awake (free tier spins
// down after 15 min idle, which would add a ~30s cold start for visitors).
refreshCatalog().catch(() => {});
if (WEBHOOK_URL) {
  setInterval(() => {
    https.get(WEBHOOK_URL, () => {}).on('error', () => {});
    getCatalog().catch(() => {});
  }, 10 * 60 * 1000);
}

// ── Search ────────────────────────────────────────────────────────────────────
function searchGames(games, query) {
  const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return [];

  const score = g => {
    const tl = g.title.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    return words.reduce((n, w) => n + (tl.includes(w) ? 1 : 0), 0);
  };

  const scored = games.map(g => ({ g, score: score(g) }));

  // Prefer games matching ALL keywords; fall back to partial if none found
  const full = scored.filter(x => x.score === words.length);
  const results = full.length ? full : scored.filter(x => x.score > 0);

  return results.sort((a, b) => b.score - a.score);
}

const CATALOG_URL = 'https://imbbloh.github.io/game-catalog/';

// ── Bot commands ──────────────────────────────────────────────────────────────
bot.onText(/\/(start|help)/i, (msg) => {
  bot.sendMessage(msg.chat.id, helpText(), { parse_mode: 'HTML' });
});

bot.onText(/\/pricelist$/i, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🗂 <b>Full Game Catalog</b>\n\nBrowse all games with prices and cover art:\n\n🔗 <a href="${CATALOG_URL}">${CATALOG_URL}</a>\n\n`
    + `💡 Tip: Use <code>/list switch</code> or <code>/list ps5</code> to filter by platform here.`,
    { parse_mode: 'HTML', disable_web_page_preview: false }
  );
});

bot.onText(/\/list(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const filter = (match[1] || '').trim().toLowerCase();

  if (!filter) {
    bot.sendMessage(chatId, '💡 Please specify a platform. E.g. <code>/list switch</code>, <code>/list switch2</code>, <code>/list ps5</code>', { parse_mode: 'HTML' });
    return;
  }

  try {
    const games    = await getGames();
    const filtered = platformFilter(games, filter);

    if (!filtered.length) {
      bot.sendMessage(chatId, `❌ No games found for platform "<b>${esc(filter)}</b>".`, { parse_mode: 'HTML' });
      return;
    }

    filtered.sort((a, b) => a.title.localeCompare(b.title));
    sendListPage(chatId, filtered, filter, 0);
  } catch(e) {
    console.error('List error:', e);
    bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

function platformFilter(games, filter) {
  const f = filter.replace(/switch2/i, 'switch 2').toLowerCase();
  return games.filter(g => {
    if (g.type === 'code') return false;
    const p = (g.platform || '').toLowerCase();
    if (f === 'switch') return p.includes('switch') && !p.includes('switch 2');
    return p.includes(f);
  });
}

function sendListPage(chatId, games, filter, page) {
  const PAGE_SIZE = 50;
  const start     = page * PAGE_SIZE;
  const slice     = games.slice(start, start + PAGE_SIZE);
  const total     = games.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  let text = `🕹 <b>${esc(filter.toUpperCase())} Games</b> (${total} total) — Page ${page + 1}/${totalPages}\n\n`;
  slice.forEach((g, i) => {
    const normal  = g.normalPrice  ? `$${g.normalPrice.toFixed(2)}`  : (g.normal  ? `$${g.normal.toFixed(2)}`  : 'N/A');
    const premium = g.premiumPrice ? `$${g.premiumPrice.toFixed(2)}` : (g.premium ? `$${g.premium.toFixed(2)}` : 'N/A');
    text += `${start + i + 1}. <b>${esc(g.title)}</b>\n`;
    text += `   🟡 ${normal} · 🟢 ${premium}\n`;
  });

  // Navigation buttons
  const navRow = [];
  if (page > 0)               navRow.push({ text: '◀ Prev', callback_data: `list:${filter}:${page - 1}` });
  if (page < totalPages - 1)  navRow.push({ text: 'Next ▶', callback_data: `list:${filter}:${page + 1}` });

  const opts = { parse_mode: 'HTML' };
  if (navRow.length) opts.reply_markup = { inline_keyboard: [navRow] };

  bot.sendMessage(chatId, text, opts);
}

bot.onText(/\/price(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const query  = (match[1] || '').trim();

  if (!query) {
    bot.sendMessage(chatId, '🎮 Please provide a game title.\n\nExample: /price Zelda', { parse_mode: 'HTML' });
    return;
  }

  try {
    const games   = await getGames();
    const matches = searchGames(games, query);

    if (!matches.length) {
      bot.sendMessage(chatId, `❌ No games found for "<b>${esc(query)}</b>".\n\nTry a different keyword.`, { parse_mode: 'HTML' });
      return;
    }

    // Send best result
    try {
      await sendGameResult(chatId, matches[0].g, query);
    } catch(e) {
      console.error('sendGameResult error:', e);
    }

    // Always show list if multiple matches (up to 10)
    if (matches.length > 1) {
      const buttons = matches.slice(0, 10).map((m, i) => ([{
        text: m.g.title,
        callback_data: `pick:${i}:${query.substring(0, 30)}`
      }]));
      try {
        await bot.sendMessage(chatId, `<i>📋 ${matches.length} games matched. Tap to view another:</i>`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons }
        });
      } catch(e) {
        console.error('inline keyboard error:', e);
      }
    }
  } catch (err) {
    console.error('Price query error:', err);
    bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

// ── Callback handler for inline buttons ───────────────────────────────────────
bot.on('callback_query', async (cbq) => {
  const chatId = cbq.message.chat.id;
  const data   = cbq.data || '';

  if (data.startsWith('list:')) {
    const parts  = data.split(':');
    const filter = parts[1];
    const page   = parseInt(parts[2], 10) || 0;
    try {
      const games    = await getGames();
      const filtered = platformFilter(games, filter).sort((a, b) => a.title.localeCompare(b.title));
      if (filtered.length) sendListPage(chatId, filtered, filter, page);
    } catch(e) { console.error('List callback error:', e); }
    bot.answerCallbackQuery(cbq.id).catch(() => {});
    return;
  }

  if (data.startsWith('pick:')) {
    const parts = data.split(':');
    const idx   = parseInt(parts[1], 10);
    const query = parts.slice(2).join(':');
    try {
      const games   = await getGames();
      const matches = searchGames(games, query);
      if (matches[idx]) {
        await sendGameResult(chatId, matches[idx].g, query);
      }
    } catch(e) {
      console.error('Callback error:', e);
    }
  }
  bot.answerCallbackQuery(cbq.id).catch(() => {});
});

// ── Send a single game result ─────────────────────────────────────────────────
async function sendGameResult(chatId, g, query) {
  const normal    = g.normalPrice  ? `$${g.normalPrice.toFixed(2)}`  : (g.normal  ? `$${g.normal.toFixed(2)}`  : 'N/A');
  const premium   = g.premiumPrice ? `$${g.premiumPrice.toFixed(2)}` : (g.premium ? `$${g.premium.toFixed(2)}` : 'N/A');
  const carousell = `https://www.carousell.sg/u/${CAROUSELL_USER}/?search=${encodeURIComponent(query)}`;
  const storeUrl  = g.url || g.eshop || '';

  let caption = `<b>${esc(g.title)}</b>\n`;
  if (g.platform) caption += `🕹 ${esc(g.platform)}\n`;
  caption += '\n';
  caption += `🟡 <b>Normal:</b> ${normal}\n`;
  caption += `🟢 <b>Premium:</b> ${premium}\n`;
  caption += '\n';
  if (storeUrl.startsWith('http')) caption += `🏪 <a href="${storeUrl}">View Store</a>\n`;
  caption += `🛒 <a href="${carousell}">Carousell Listing</a>`;

  const cover = g.cover || '';
  if (cover.startsWith('http')) {
    await bot.sendPhoto(chatId, cover, { caption, parse_mode: 'HTML' }).catch(() => {
      bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: false });
    });
  } else {
    await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: false });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function helpText() {
  return '👋 <b>Game Price Bot</b>\n\n'
    + '<b>Commands:</b>\n\n'
    + '<code>/price &lt;game title&gt;</code>\n'
    + 'Search for a game price\n\n'
    + '<code>/pricelist</code>\n'
    + 'Browse full catalog on web\n\n'
    + '<code>/list &lt;platform&gt;</code>\n'
    + 'Filter by platform (e.g. /list switch, /list ps5)\n\n'
    + '<b>Examples:</b>\n'
    + '• /price Zelda\n'
    + '• /price Mario Kart\n'
    + '• /list switch\n'
    + '• /list ps5\n\n'
    + "You don't need the exact title — keywords work!\n\n"
    + 'Each result shows:\n'
    + '🖼 Cover art\n'
    + '🟡 Normal · 🟢 Premium prices\n'
    + '🏪 Store link\n'
    + '🛒 Carousell listing';
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
