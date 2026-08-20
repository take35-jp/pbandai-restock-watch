// ============================================================================
// プレバン在庫復活ウォッチャー — Playwright版デーモン（Bot対策突破）
// ----------------------------------------------------------------------------
// 旧版（watch-daemon.mjs）はNode fetchでプレバンにアクセスしていたが、
// STC Bot Manager（https://restriction.p-bandai.jp/... へリダイレクト）に
// 弾かれるため取得できない状態になった。この版は Playwright + Chromium で
// 実ブラウザとしてアクセスし、stealth設定でheadless指紋を隠して突破する。
//
// セットアップ:
//   cd C:\Users\taker\Documents\GitHub\pbandai-restock-watch\vm
//   npm install                         （Chromiumも自動ダウンロード）
//
// 環境変数:
//   DISCORD_WEBHOOK_URL   (必須) Discord Webhook
//   INTERVAL_MS           (任意) チェック間隔ms。既定 30000
//   REQUEST_GAP_MS        (任意) 商品間の待ち。既定 2000
//   WATCHLIST_URL         (任意) 既定は本リポジトリの raw watchlist.json
//   WATCHLIST_REFRESH_MS  (任意) watchlist再取得間隔ms。既定 300000(5分)
//   STATE_FILE            (任意) 状態保存先。既定 ./state-daemon.json
// ============================================================================

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 30000);
const REQUEST_GAP_MS = Number(process.env.REQUEST_GAP_MS || 4000);
const RETRY_ON_EMPTY = Number(process.env.RETRY_ON_EMPTY || 1); // noLd時のリトライ回数
const WATCHLIST_URL = process.env.WATCHLIST_URL ||
  'https://raw.githubusercontent.com/take35-jp/pbandai-restock-watch/main/watchlist.json';
const WATCHLIST_REFRESH_MS = Number(process.env.WATCHLIST_REFRESH_MS || 300000);
const STATE_FILE = process.env.STATE_FILE || path.join(DIR, 'state-daemon.json');
const BROWSER_RESTART_EVERY = Number(process.env.BROWSER_RESTART_EVERY || 60); // Nティックごとに再起動

const ORDERABLE = new Set(['InStock', 'PreOrder', 'BackOrder', 'LimitedAvailability', 'OnlineOnly', 'InStoreOnly']);
const CLOSED = new Set(['OutOfStock', 'SoldOut', 'Discontinued', 'PreSale']);
const STATUS_JA = {
  InStock: '在庫あり', PreOrder: '予約受付中', BackOrder: 'お取り寄せ',
  LimitedAvailability: '数量限定', OnlineOnly: 'ネット限定', InStoreOnly: '店頭限定',
  OutOfStock: '受付終了/売切', SoldOut: '売切', Discontinued: '販売終了',
  PreSale: '販売前', unknown: '不明',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

let state = {};
let watch = [];
let lastWatchFetch = 0;
let browser = null, ctx = null, page = null;

function classify(av) {
  if (ORDERABLE.has(av)) return 'orderable';
  if (CLOSED.has(av)) return 'closed';
  return 'unknown';
}

function parseProduct(html) {
  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const b of blocks) {
    let data; try { data = JSON.parse(b); } catch { continue; }
    for (const node of Array.isArray(data) ? data : [data]) {
      if (node && node['@type'] === 'Product') {
        let offers = node.offers; if (Array.isArray(offers)) offers = offers[0];
        const av = (offers?.availability || '').replace(/^https?:\/\/schema\.org\//, '');
        const image = typeof node.image === 'string' ? node.image : Array.isArray(node.image) ? node.image[0] : '';
        return { name: node.name || '', image, price: offers?.price || '', availability: av || 'unknown' };
      }
    }
  }
  return null;
}

async function initBrowser() {
  try { if (browser) await browser.close(); } catch {}
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  ctx = await browser.newContext({
    userAgent: UA,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8' },
  });
  // Stealth: headless指紋を隠す（STC Bot Manager対策）
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en'] });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    const orig = navigator.permissions.query;
    navigator.permissions.query = (p) => p.name === 'notifications' ? Promise.resolve({ state: 'default' }) : orig(p);
  });
  page = await ctx.newPage();
  // 画像/CSSはブロックして高速化＆負荷軽減
  await ctx.route('**/*', (route) => {
    const rt = route.request().resourceType();
    if (rt === 'image' || rt === 'stylesheet' || rt === 'font' || rt === 'media') return route.abort();
    return route.continue();
  });
  log('browser initialized (Chromium + stealth)');
}

async function fetchItemOnce(url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Product JSON-LD が実際にDOMに現れるまで待つ（networkidleより信頼できる）
    await page.waitForFunction(
      () => {
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          const t = s.textContent || '';
          if (t.includes('"Product"')) return true;
        }
        return false;
      },
      { timeout: 15000 },
    ).catch(() => {});
    const finalUrl = page.url();
    if (finalUrl.includes('restriction.p-bandai.jp')) return { ok: false, status: 'blocked' };
    const html = await page.content();
    if (html.length < 5000) return { ok: false, noLd: true, empty: true };
    const info = parseProduct(html);
    if (!info) return { ok: false, noLd: true };
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function fetchItem(url) {
  let last = await fetchItemOnce(url);
  for (let i = 0; i < RETRY_ON_EMPTY && !last.ok && (last.noLd || last.empty); i++) {
    await sleep(3000 + Math.random() * 2000); // 3〜5秒待って再挑戦
    last = await fetchItemOnce(url);
  }
  return last;
}

async function sendDiscord(item, info, prevAv) {
  if (!WEBHOOK) { log('[no webhook] would notify', item.url); return; }
  const label = info.name || item.label || item.url;
  const price = info.price ? `¥${Number(info.price).toLocaleString('ja-JP')}` : '—';
  const payload = {
    content: '🛒 **プレバンで注文可になりました！**',
    embeds: [{
      title: label, url: item.url,
      description: `状態: **${STATUS_JA[prevAv] || prevAv} → ${STATUS_JA[info.availability] || info.availability}**\n価格: ${price}`,
      color: 0x2ecc71,
      ...(info.image ? { thumbnail: { url: info.image } } : {}),
    }],
  };
  try {
    const res = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    log('discord ->', res.status);
  } catch (e) { log('discord error', e.message); }
}

async function loadState() {
  try { state = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { state = {}; }
}
async function saveState() {
  try { await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n'); }
  catch (e) { log('state save error', e.message); }
}

async function refreshWatchlist(force) {
  if (!force && Date.now() - lastWatchFetch < WATCHLIST_REFRESH_MS) return;
  try {
    const r = await fetch(WATCHLIST_URL, { cache: 'no-store', headers: { 'User-Agent': UA } });
    if (!r.ok) { log('watchlist fetch status', r.status); return; }
    const arr = await r.json();
    watch = arr.map((x) => (typeof x === 'string' ? { url: x, label: '' } : { url: x.url || '', label: x.label || '' })).filter((x) => x.url);
    lastWatchFetch = Date.now();
    log('watchlist refreshed:', watch.length, 'items');
  } catch (e) { log('watchlist fetch error', e.message); }
}

async function tick() {
  await refreshWatchlist(false);
  let ord = 0, cls = 0, blocked = 0, skipped = 0;
  for (const item of watch) {
    try {
      const info = await fetchItem(item.url);
      if (!info.ok) {
        if (info.status === 'blocked') blocked++;
        else skipped++;
        log('skip', info.status || info.error || 'noLd', item.url);
        await sleep(REQUEST_GAP_MS);
        continue;
      }
      const klass = classify(info.availability);
      if (klass === 'orderable') ord++;
      if (klass === 'closed') cls++;
      const prev = state[item.url];
      const prevKlass = prev?.klass || 'unknown';
      if (prevKlass === 'closed' && klass === 'orderable') {
        await sendDiscord(item, info, prev.availability);
        log('*** NOTIFY', prev.availability, '->', info.availability, info.name);
      }
      if (!prev || prev.availability !== info.availability) {
        state[item.url] = { availability: info.availability, klass, name: info.name };
        await saveState();
        log(prevKlass, '->', klass, `(${info.availability})`, info.name || item.url);
      }
    } catch (e) { log('ERR', item.url, e.message); }
    await sleep(REQUEST_GAP_MS);
  }
  log(`tick: ${watch.length} items, ${ord} orderable, ${cls} closed, ${blocked} blocked, ${skipped} skipped`);
  return { blocked };
}

async function main() {
  if (!WEBHOOK) log('WARN: DISCORD_WEBHOOK_URL 未設定（通知はスキップされます）');
  await loadState();
  await refreshWatchlist(true);
  await initBrowser();
  log('daemon start. interval=', INTERVAL_MS, 'ms, items=', watch.length);
  let cycle = 0;
  for (;;) {
    const t0 = Date.now();
    try {
      const r = await tick();
      cycle++;
      // 全部ブロックされ続けたら次サイクルで再起動（フィンガープリント/セッションリセット）
      if (r?.blocked === watch.length && watch.length > 0) {
        log('all items blocked, restarting browser');
        await initBrowser();
      } else if (cycle % BROWSER_RESTART_EVERY === 0) {
        log(`periodic browser restart (cycle ${cycle})`);
        await initBrowser();
      }
    } catch (e) {
      log('tick error, restarting browser:', e.message);
      try { await initBrowser(); } catch (err) { log('reinit failed', err.message); await sleep(30000); }
    }
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)));
  }
}

process.on('SIGINT', async () => { log('SIGINT'); try { await browser?.close(); } catch {} process.exit(0); });
process.on('SIGTERM', async () => { log('SIGTERM'); try { await browser?.close(); } catch {} process.exit(0); });

main().catch((e) => { console.error(e); process.exit(1); });
