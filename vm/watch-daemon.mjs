// ============================================================================
// プレバン在庫復活ウォッチャー — 常時稼働デーモン版（VM向け）
// ----------------------------------------------------------------------------
// GitHub Actions版（5分制限あり）との違い:
//   - 長時間プロセスとして動き、約45秒間隔でチェック（INTERVAL_MSで調整可）
//   - watchlist は GitHub から定期取得 → admin.html の編集がそのまま反映される
//   - 状態はローカルファイルに永続化 → 再起動しても誤通知・重複通知しない
//
// 環境変数:
//   DISCORD_WEBHOOK_URL   (必須) Discord Webhook
//   INTERVAL_MS           (任意) チェック間隔ms。既定 45000
//   REQUEST_GAP_MS        (任意) 商品間の待ち。既定 1000（プレバンに優しく）
//   WATCHLIST_URL         (任意) 既定は本リポジトリの raw watchlist.json
//   WATCHLIST_REFRESH_MS  (任意) watchlist再取得間隔ms。既定 300000(5分)
//   STATE_FILE            (任意) 状態保存先。既定 ./state-daemon.json
//
// 実行: DISCORD_WEBHOOK_URL=... node watch-daemon.mjs
// 常時稼働: 同梱の restock-watch.service（systemd）参照
// ============================================================================

import { readFile, writeFile } from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 45000);
const REQUEST_GAP_MS = Number(process.env.REQUEST_GAP_MS || 1000);
const WATCHLIST_URL = process.env.WATCHLIST_URL ||
  'https://raw.githubusercontent.com/take35-jp/pbandai-restock-watch/main/watchlist.json';
const WATCHLIST_REFRESH_MS = Number(process.env.WATCHLIST_REFRESH_MS || 300000);
const STATE_FILE = process.env.STATE_FILE || './state-daemon.json';

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

let state = {};               // url -> { availability, klass, name }
let watch = [];               // [{ url, label }]
let lastWatchFetch = 0;

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

async function fetchItem(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.9' }, redirect: 'follow' });
  if (!r.ok) return { ok: false, status: r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  const html = new TextDecoder('shift_jis').decode(buf);
  const info = parseProduct(html);
  if (!info) return { ok: false, status: r.status, noLd: true };
  return { ok: true, status: r.status, ...info };
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
  const res = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  log('discord ->', res.status);
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
  for (const item of watch) {
    try {
      const info = await fetchItem(item.url);
      if (!info.ok) { log('skip', info.status, item.url); await sleep(REQUEST_GAP_MS); continue; }
      const klass = classify(info.availability);
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
}

async function main() {
  if (!WEBHOOK) log('WARN: DISCORD_WEBHOOK_URL 未設定（通知はスキップされます）');
  await loadState();
  await refreshWatchlist(true);
  log('daemon start. interval=', INTERVAL_MS, 'ms, items=', watch.length);
  for (;;) {
    const t0 = Date.now();
    try { await tick(); } catch (e) { log('tick error', e.message); }
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)));
  }
}

main();
