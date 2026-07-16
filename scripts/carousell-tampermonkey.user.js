// ==UserScript==
// @name         Carousell → GitHub Auto-Push
// @namespace    https://github.com/imbbloh/game-catalog
// @version      2.0
// @description  Scrapes all Carousell listings and pushes carousell-listings.json to GitHub automatically
// @author       imbbloh
// @match        https://www.carousell.sg/u/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.github.com
// ==/UserScript==

(function () {
  'use strict';

  // ── CONFIG — fill these in ──────────────────────────────────────────────────
  const GITHUB_TOKEN = 'YOUR_GITHUB_PAT_HERE';   // paste your Personal Access Token
  const GITHUB_REPO  = 'imbbloh/game-catalog';
  const GITHUB_FILE  = 'carousell-listings.json';
  const GITHUB_BRANCH = 'main';
  // ───────────────────────────────────────────────────────────────────────────

  const USER = location.pathname.replace(/^\/u\//, '').replace(/\/$/, '');

  // ── Intercept Carousell's own API responses ─────────────────────────────────
  const apiData = new Map(); // id → { title, price }

  function walkObj(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    if (Array.isArray(obj)) { obj.forEach(v => walkObj(v, depth + 1)); return; }
    const id    = String(obj.id || obj.listingId || obj.listing_id || '');
    const title = obj.title || obj.name || obj.listing_title || obj.header || '';
    const raw   = obj.price ?? obj.listing_price ?? obj.priceTag ?? obj.price_cents;
    let price   = null;
    if (typeof raw === 'number')      price = raw > 1000 ? raw / 100 : raw;
    else if (typeof raw === 'string') price = parseFloat(raw.replace(/[^0-9.]/g, '')) || null;
    else if (raw && typeof raw === 'object') {
      const v = raw.amount ?? raw.value ?? raw.figure ?? raw.display ?? '';
      price = parseFloat(String(v).replace(/[^0-9.]/g, '')) || null;
      if (price > 10000) price /= 100;
    }
    if (id && title) apiData.set(id, { title: String(title).trim(), price });
    Object.values(obj).forEach(v => walkObj(v, depth + 1));
  }

  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener('load', function () {
      try {
        if ((this.getResponseHeader('content-type') || '').includes('json')) {
          walkObj(JSON.parse(this.responseText));
        }
      } catch (_) {}
    });
    return _open.apply(this, args);
  };

  // ── UI button ───────────────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.textContent = '⬆ Push to GitHub';
  Object.assign(btn.style, {
    position: 'fixed', bottom: '24px', right: '24px', zIndex: 99999,
    background: '#238636', color: '#fff', border: 'none', borderRadius: '8px',
    padding: '12px 20px', fontSize: '15px', fontWeight: 'bold',
    cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
  });
  document.body.appendChild(btn);

  function setStatus(msg, color = '#238636') {
    btn.textContent = msg;
    btn.style.background = color;
  }

  // ── Collect listings from DOM + API intercept ───────────────────────────────
  function collectListings() {
    const seen = new Set();
    const listings = [];
    document.querySelectorAll('a[href*="/p/"]').forEach(a => {
      const m = a.getAttribute('href').match(/\/p\/(?:[^/]*-)?(\d+)\/?/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);
      const api      = apiData.get(id);
      const domText  = (a.closest('li, article, [data-testid]')?.textContent || '').trim().slice(0, 600);
      let price      = api?.price ?? null;
      if (price === null) {
        const prices = domText.match(/S\$\s?[\d,]+(?:\.\d{1,2})?/g);
        if (prices) price = parseFloat(prices[prices.length - 1].replace(/[^0-9.]/g, '')) || null;
      }
      listings.push({
        id,
        url:   `https://www.carousell.sg/p/${id}/`,
        href:  a.getAttribute('href'),
        text:  api?.title ?? domText.slice(0, 300),
        price,
      });
    });
    return listings;
  }

  // ── Scroll until all listings are loaded ───────────────────────────────────
  async function scrollToBottom() {
    setStatus('Scrolling…', '#1158c7');
    let prev = -1, stable = 0;
    for (let i = 0; i < 300; i++) {
      // Click "View more" if visible
      const viewMore = [...document.querySelectorAll('button, [role="button"]')]
        .find(el => el.textContent.trim().toLowerCase().includes('view more'));
      if (viewMore) viewMore.click();
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(700);
      const count = document.querySelectorAll('a[href*="/p/"]').length;
      if (count === prev) {
        if (++stable >= 5 && !viewMore) break;
      } else {
        stable = 0;
      }
      prev = count;
      if (i % 10 === 0) setStatus(`Scrolling… (${count} found)`, '#1158c7');
    }
  }

  // ── Push JSON to GitHub via API ─────────────────────────────────────────────
  function githubRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `https://api.github.com${path}`,
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: r => {
          try { resolve({ status: r.status, data: JSON.parse(r.responseText) }); }
          catch (_) { resolve({ status: r.status, data: {} }); }
        },
        onerror: reject,
      });
    });
  }

  async function pushToGitHub(listings) {
    setStatus('Getting current file SHA…', '#1158c7');
    // Get current file SHA (needed for update)
    const { status, data } = await githubRequest(
      'GET',
      `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`
    );
    const sha = status === 200 ? data.sha : undefined;

    const content = JSON.stringify({ ts: Date.now(), user: USER, listings }, null, 1);
    const encoded = btoa(unescape(encodeURIComponent(content))); // UTF-8 safe base64

    setStatus('Pushing to GitHub…', '#1158c7');
    const result = await githubRequest(
      'PUT',
      `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      {
        message: `Update Carousell listings (${listings.length} items)`,
        content: encoded,
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
      }
    );

    if (result.status === 200 || result.status === 201) {
      setStatus(`✅ Pushed ${listings.length} listings!`, '#238636');
    } else {
      console.error('GitHub push failed:', result);
      setStatus(`❌ Push failed (${result.status})`, '#b91c1c');
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Main ────────────────────────────────────────────────────────────────────
  btn.addEventListener('click', async () => {
    if (GITHUB_TOKEN === 'YOUR_GITHUB_PAT_HERE') {
      alert('Please set your GITHUB_TOKEN in the Tampermonkey script first.');
      return;
    }
    btn.disabled = true;
    try {
      await scrollToBottom();
      const listings = collectListings();
      setStatus(`Found ${listings.length} listings — pushing…`, '#1158c7');
      if (listings.length < 5) {
        setStatus(`⚠ Only ${listings.length} found — try scrolling manually first`, '#b45309');
        btn.disabled = false;
        return;
      }
      await pushToGitHub(listings);
    } catch (err) {
      console.error(err);
      setStatus('❌ Error — check console', '#b91c1c');
    }
    btn.disabled = false;
  });
})();
