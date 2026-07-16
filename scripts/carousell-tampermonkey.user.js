// ==UserScript==
// @name         Carousell Listing Scraper v8
// @namespace    http://tampermonkey.net/
// @version      8.0
// @match        https://www.carousell.sg/u/*
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// ==/UserScript==

(function () {
  'use strict';

  // ── CONFIG — paste your GitHub Personal Access Token here ──────────────────
  const GITHUB_TOKEN  = 'YOUR_GITHUB_PAT_HERE';
  const GITHUB_REPO   = 'imbbloh/game-catalog';
  const GITHUB_FILE   = 'carousell-listings.json';
  const GITHUB_BRANCH = 'main';
  // ───────────────────────────────────────────────────────────────────────────

  const captured = new Map();

  function extractId(href) {
    let m = href.match(/\/p\/(\d+)\/?/);
    if (m) return m[1];
    m = href.match(/\/p\/[^/?#]*?-(\d{6,})[/?#]?/);
    if (m) return m[1];
    return null;
  }

  function scrapeDOM() {
    for (const a of document.querySelectorAll('a[href*="/p/"]')) {
      const id = extractId(a.href);
      if (!id || captured.has(id)) continue;
      const card = a.closest('li, article, [data-testid]') || a.parentElement;
      const cardText = card?.innerText || '';
      const lines = cardText.split('\n').map(l => l.trim()).filter(Boolean);
      const rawTitle = lines[0] || '';
      const title = rawTitle.replace(/^[✅❗️⚠️<>\s]+/, '').split(/\s*[–—]\s*/)[0].trim();
      const pm = cardText.match(/S\$\s?([\d,]+(?:\.\d{1,2})?)/);
      const price = pm ? parseFloat(pm[1].replace(/,/g, '')) : null;
      captured.set(id, { id, title, price, url: `https://www.carousell.sg/p/${id}/`, text: rawTitle });
    }
  }

  function findViewMore() {
    for (const el of document.querySelectorAll('button, [role="button"], a, span, p')) {
      if (!el.offsetParent) continue;
      if (/^view\s*more/i.test(el.textContent.trim())) return el;
    }
    return null;
  }

  async function waitForListings(minCount = 5, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (document.querySelectorAll('a[href*="/p/"]').length >= minCount) return true;
      await delay(300);
    }
    return false;
  }

  async function applyActiveFilter() {
    const filterBtn = [...document.querySelectorAll('button')]
      .find(el => /filter/i.test(el.textContent.trim()) && el.offsetParent);
    if (!filterBtn) { status.textContent = 'Filter button not found — scraping all'; return; }
    filterBtn.click();
    await delay(800);

    for (const el of document.querySelectorAll('label, [role="checkbox"]')) {
      const t = el.textContent.trim();
      const cb = el.querySelector('input[type="checkbox"]') || el;
      if (/^active$/i.test(t) && !cb.checked) { el.click(); await delay(300); }
      if (/^(inactive|reserved|sold)$/i.test(t) && cb.checked) { el.click(); await delay(300); }
    }

    const applyBtn = [...document.querySelectorAll('button')]
      .find(el => /^apply$/i.test(el.textContent.trim()) && el.offsetParent);
    if (applyBtn) {
      applyBtn.click();
      status.textContent = 'Filter applied — waiting for listings…';
      await waitForListings(5, 10000);
      await delay(500);
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'fixed', top: '10px', right: '10px', zIndex: 99999,
    display: 'flex', flexDirection: 'column', gap: '6px', width: '210px',
  });
  document.body.appendChild(panel);

  const status = document.createElement('div');
  Object.assign(status.style, {
    background: 'rgba(0,0,0,.85)', color: '#fff', padding: '8px 12px',
    borderRadius: '6px', fontSize: '13px',
  });
  status.textContent = 'Ready — click Scrape';
  panel.appendChild(status);

  function makeBtn(label, color, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      padding: '10px 16px', background: color, color: '#fff',
      border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px',
    });
    b.addEventListener('click', fn);
    panel.appendChild(b);
    return b;
  }

  const scrapeBtn = makeBtn('🔍 Scrape & Push to GitHub', '#e6440a', scrape);
  makeBtn('💾 Export JSON', '#0a0', download);

  async function scrape() {
    scrapeBtn.disabled = true;
    captured.clear();
    status.textContent = 'Applying Active filter…';

    await applyActiveFilter();

    let stable = 0, prevSize = -1;
    while (true) {
      scrapeDOM();
      status.textContent = `Captured: ${captured.size} — loading more…`;

      const vm = findViewMore();
      if (vm) {
        vm.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await delay(600);
        vm.click();
        await delay(2500);
        stable = 0;
      } else {
        window.scrollTo(0, document.body.scrollHeight);
        await delay(1500);
        if (captured.size === prevSize) { if (++stable >= 4) break; }
        else stable = 0;
      }
      prevSize = captured.size;
    }

    scrapeDOM();
    scrapeBtn.disabled = false;
    scrapeBtn.textContent = '🔍 Scrape & Push to GitHub';
    status.textContent = `✅ Done! ${captured.size} listings — pushing to GitHub…`;
    await pushToGitHub();
  }

  // ── GitHub push ─────────────────────────────────────────────────────────────
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

  async function pushToGitHub() {
    if (GITHUB_TOKEN === 'YOUR_GITHUB_PAT_HERE') {
      alert('Please set your GITHUB_TOKEN in the Tampermonkey script first.');
      return;
    }
    const listings = [...captured.values()];
    if (listings.length < 5) {
      alert(`Only ${listings.length} listings captured — run Scrape first.`);
      return;
    }

    status.textContent = 'Getting file SHA…';
    const { status: s, data } = await githubRequest(
      'GET',
      `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`
    );
    const sha = s === 200 ? data.sha : undefined;

    const user = location.pathname.replace(/^\/u\//, '').replace(/\/$/, '');
    const content = JSON.stringify({ ts: Date.now(), user, listings }, null, 1);
    const encoded = btoa(unescape(encodeURIComponent(content)));

    status.textContent = 'Pushing to GitHub…';
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
      status.textContent = `✅ Pushed ${listings.length} listings to GitHub!`;
    } else {
      console.error('GitHub push failed:', result);
      status.textContent = `❌ Push failed (${result.status}) — check console`;
    }
  }

  function download() {
    const listings = [...captured.values()];
    const out = { ts: Date.now(), user: 'im.bbloh', listings };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'carousell-listings.json';
    a.click();
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
