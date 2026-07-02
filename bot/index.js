const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

// ── Config (set these as Render environment variables) ────────────────────────
const BOT_TOKEN      = process.env.BOT_TOKEN;
const WEBHOOK_URL    = process.env.WEBHOOK_URL; // e.g. https://your-app.onrender.com
const SHEET_ID       = process.env.SHEET_ID || '1ly37Y9r-_q44Fp7DpfMVlo_8JdYPHCHwapA6kHy-msw';
const GOOGLE_CREDS   = process.env.GOOGLE_CREDS; // service account JSON string
const CAROUSELL_USER = 'im.bbloh';
const PORT           = process.env.PORT || 3000;

// ── Telegram bot (webhook mode) ───────────────────────────────────────────────
const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN);
bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('Game Catalog Bot is running.'));

// ── Google Sheets client ──────────────────────────────────────────────────────
let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const creds = JSON.parse(GOOGLE_CREDS);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// ── Game data cache (5 min TTL) ───────────────────────────────────────────────
let gamesCache     = null;
let gamesCacheTime = 0;

async function getGames() {
  if (gamesCache && Date.now() - gamesCacheTime < 5 * 60 * 1000) return gamesCache;

  const sheets   = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'A2:I',
  });

  const rows = response.data.values || [];
  gamesCache = rows
    .filter(r => r[0] && r[0].trim())
    .map(r => ({
      title:    (r[0] || '').trim(),
      normal:   parseFloat(r[1]) || null,
      premium:  parseFloat(r[2]) || null,
      platform: (r[3] || '').trim(),
      url:      (r[4] || '').trim(),
      cover:    (r[8] || '').trim(),
    }));

  gamesCacheTime = Date.now();
  return gamesCache;
}

// ── Search logic ──────────────────────────────────────────────────────────────
function searchGames(games, query) {
  const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1);
  const matches = [];

  games.forEach(g => {
    const tl    = g.title.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    let score   = 0;
    words.forEach(w => { if (tl.includes(w)) score++; });
    if (score > 0) matches.push({ g, score });
  });

  matches.sort((a, b) => b.score - a.score);
  return matches;
}

// ── Message handlers ──────────────────────────────────────────────────────────
bot.onText(/\/(start|help)/i, (msg) => {
  bot.sendMessage(msg.chat.id, helpText(), { parse_mode: 'HTML' });
});

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

    const g         = matches[0].g;
    const normal    = g.normal  ? `$${g.normal.toFixed(2)}`  : 'N/A';
    const premium   = g.premium ? `$${g.premium.toFixed(2)}` : 'N/A';
    const carousell = `https://www.carousell.sg/u/${CAROUSELL_USER}/?search=${encodeURIComponent(query)}`;

    let caption = `<b>${esc(g.title)}</b>\n`;
    if (g.platform) caption += `🕹 ${esc(g.platform)}\n`;
    caption += '\n';
    caption += `💰 <b>Normal:</b> ${normal}\n`;
    caption += `⭐ <b>Premium:</b> ${premium}\n`;
    caption += '\n';
    if (g.url.startsWith('http')) caption += `🏪 <a href="${g.url}">View eShop</a>\n`;
    caption += `🛒 <a href="${carousell}">Carousell Listing</a>`;
    if (matches.length > 1) caption += `\n\n<i>${matches.length} games matched — showing best result</i>`;

    if (g.cover.startsWith('http')) {
      bot.sendPhoto(chatId, g.cover, { caption, parse_mode: 'HTML' }).catch(() => {
        bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: false });
      });
    } else {
      bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: false });
    }
  } catch (err) {
    console.error('Price query error:', err);
    bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function helpText() {
  return '👋 <b>Game Price Bot</b>\n\n'
    + 'Search for game prices:\n\n'
    + '<code>/price &lt;game title&gt;</code>\n\n'
    + '<b>Examples:</b>\n'
    + '• /price Zelda\n'
    + '• /price Mario Kart\n'
    + '• /price bananza\n\n'
    + "You don't need the exact title — keywords work!\n\n"
    + 'Each result shows:\n'
    + '🖼 Cover art\n'
    + '💰 Normal &amp; Premium prices\n'
    + '🏪 eShop link\n'
    + '🛒 Carousell listing';
}

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
