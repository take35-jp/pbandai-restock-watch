// ============================================================================
// 在庫復活ウォッチャー — Amazon PA-API + 楽天API 版
// ----------------------------------------------------------------------------
// プレバン用の旧daemonは Bot 対策で使えなくなったため、公式APIベースに移行。
// スクレイピングではなく事業者提供のAPIなので、規約OK・安定・軽量（無ブラウザ）。
//
// watchlistスキーマ:
//   [
//     { "platform": "amazon", "id": "B08XXXX", "label": "MG ..." },
//     { "platform": "rakuten", "id": "4573102638885", "label": "HG ..." }
//   ]
//
// 必要な環境変数（同フォルダの .env で指定推奨）:
//   DISCORD_WEBHOOK_URL          必須
//   AMAZON_PAAPI_ACCESS_KEY      Amazon Creators API client_id
//   AMAZON_PAAPI_SECRET_KEY      Amazon Creators API client_secret
//   AMAZON_PARTNER_TAG           Associate tag (例: tsumitsumi232-22)
//   RAKUTEN_APP_ID               楽天App ID
//   RAKUTEN_ACCESS_KEY           (任意) 楽天Access Key
//   INTERVAL_MS                  デフォルト 300000 (5分)
// ============================================================================

import fs from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- .env 読み込み ----
(function loadEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
})(path.join(DIR, '.env'));

// ---- 設定 ----
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 300000);
const STATE_FILE = process.env.STATE_FILE || path.join(DIR, 'state.json');
const WATCHLIST_URL = process.env.WATCHLIST_URL ||
  'https://raw.githubusercontent.com/take35-jp/pbandai-restock-watch/main/watchlist.json';
const WATCHLIST_REFRESH_MS = Number(process.env.WATCHLIST_REFRESH_MS || 300000);

const AMAZON_CID = process.env.AMAZON_PAAPI_ACCESS_KEY || '';
const AMAZON_SEC = process.env.AMAZON_PAAPI_SECRET_KEY || '';
const AMAZON_TAG = process.env.AMAZON_PARTNER_TAG || '';
const RAKUTEN_APP_ID = process.env.RAKUTEN_APP_ID || '';
const RAKUTEN_ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY || '';

const AMAZON_TOKEN_URL = 'https://api.amazon.co.jp/auth/o2/token';
const AMAZON_API_URL = 'https://creatorsapi.amazon/catalog/v1/getItems';
const RAKUTEN_ENDPOINT = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';
const RAKUTEN_REFERER = 'https://tsumitsumi.vercel.app/';

// 楽天で信頼できるショップ（転売プレミア排除）
const TRUSTED_SHOPS_RAKUTEN = new Set([
  'book', 'rakutenkobo', 'amiami', 'surugaya-a-too',
  'yodobashi', 'joshin', 'biccamera',
]);

// ---- ユーティリティ ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

let state = {};
let watch = [];
let lastWatchFetch = 0;
let amazonToken = null;
let amazonTokenExpires = 0;

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
    const r = await fetch(WATCHLIST_URL, { cache: 'no-store' });
    if (!r.ok) { log('watchlist status', r.status); return; }
    const arr = await r.json();
    watch = arr.map((x) => {
      if (!x || typeof x !== 'object') return null;
      const p = String(x.platform || '').toLowerCase();
      const id = String(x.id || x.asin || x.jan || '').trim();
      if (!id || (p !== 'amazon' && p !== 'rakuten')) return null;
      const priceMax = (typeof x.priceMax === 'number' && x.priceMax > 0) ? x.priceMax : null;
      return { platform: p, id, label: x.label || '', url: x.url || '', priceMax };
    }).filter(Boolean);
    lastWatchFetch = Date.now();
    log('watchlist refreshed:', watch.length, 'items');
  } catch (e) { log('watchlist error', e.message); }
}

// ---- Amazon PA-API (Creators API) ----
async function amazonGetToken() {
  if (amazonToken && Date.now() < amazonTokenExpires - 60000) return amazonToken;
  const r = await fetch(AMAZON_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: AMAZON_CID, client_secret: AMAZON_SEC,
      scope: 'creatorsapi::default',
    }).toString(),
  });
  if (!r.ok) throw new Error('amazon token ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const j = await r.json();
  amazonToken = j.access_token;
  amazonTokenExpires = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return amazonToken;
}

async function amazonGetItems(asins) {
  const tok = await amazonGetToken();
  const r = await fetch(AMAZON_API_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + tok,
      'Content-Type': 'application/json',
      'x-marketplace': 'www.amazon.co.jp',
    },
    body: JSON.stringify({
      itemIds: asins, itemIdType: 'ASIN',
      resources: [
        'itemInfo.title',
        'images.primary.medium',
        'offersV2.listings.price',
        'offersV2.listings.availability',
      ],
      partnerTag: AMAZON_TAG,
      partnerType: 'Associates',
    }),
  });
  if (!r.ok) throw new Error('amazon getItems ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return (await r.json()).itemsResult?.items || [];
}

async function checkAmazon(items) {
  if (!items.length) return [];
  if (!AMAZON_CID || !AMAZON_SEC) { log('WARN: Amazon認証情報未設定'); return items.map(s => ({ key: `amazon:${s.id}`, src: s, ok: false, error: 'no auth' })); }
  const results = [];
  const bySrc = new Map(items.map((i) => [i.id, i]));
  const batches = chunk(items.map((i) => i.id), 10);
  for (let bi = 0; bi < batches.length; bi++) {
    try {
      const resp = await amazonGetItems(batches[bi]);
      const seen = new Set();
      for (const it of resp) {
        const src = bySrc.get(it.asin); if (!src) continue;
        seen.add(it.asin);
        const listing = it.offersV2?.listings?.[0];
        const av = listing?.availability?.type || 'Unknown';
        const price = listing?.price?.money?.amount ?? null;
        const title = it.itemInfo?.title?.displayValue || '';
        const image = it.images?.primary?.medium?.url || '';
        const url = it.detailPageUrl || src.url || `https://www.amazon.co.jp/dp/${src.id}${AMAZON_TAG ? `?tag=${AMAZON_TAG}` : ''}`;
        results.push({
          key: `amazon:${src.id}`, src, ok: true,
          name: title || src.label || src.id,
          availability: av,
          klass: av === 'Now' ? 'orderable' : 'closed',
          price, image, url,
        });
      }
      for (const a of batches[bi]) {
        if (!seen.has(a)) {
          const src = bySrc.get(a);
          results.push({ key: `amazon:${a}`, src, ok: false, error: 'not returned (invalid ASIN?)' });
        }
      }
    } catch (e) {
      log('amazon batch err', e.message);
      for (const a of batches[bi]) results.push({ key: `amazon:${a}`, src: bySrc.get(a), ok: false, error: e.message });
    }
    if (bi < batches.length - 1) await sleep(1200);
  }
  return results;
}

// ---- 楽天IchibaItem API ----
async function rakutenSearch(jan) {
  const params = new URLSearchParams({
    applicationId: RAKUTEN_APP_ID,
    keyword: jan,
    hits: '30',
    availability: '1',
    format: 'json',
  });
  if (RAKUTEN_ACCESS_KEY) params.set('accessKey', RAKUTEN_ACCESS_KEY);
  const r = await fetch(`${RAKUTEN_ENDPOINT}?${params.toString()}`, {
    headers: { Referer: RAKUTEN_REFERER, 'User-Agent': 'restock-watch/1.0' },
  });
  if (!r.ok) throw new Error('rakuten ' + r.status);
  const data = await r.json();
  const items = (data.Items || []).map((w) => w.Item || w).filter(Boolean);
  const exact = items.filter((it) => `${it.itemName || ''}${it.itemCaption || ''}${it.itemCode || ''}`.includes(jan));
  const trusted = exact.filter((it) => TRUSTED_SHOPS_RAKUTEN.has(it.shopCode));
  return { trusted, exact };
}

async function checkRakuten(items) {
  if (!items.length) return [];
  if (!RAKUTEN_APP_ID) { log('WARN: 楽天認証情報未設定'); return items.map(s => ({ key: `rakuten:${s.id}`, src: s, ok: false, error: 'no auth' })); }
  const results = [];
  for (const src of items) {
    try {
      const { trusted, exact } = await rakutenSearch(src.id);
      if (trusted.length > 0) {
        trusted.sort((a, b) => (a.itemPrice || 0) - (b.itemPrice || 0));
        const top = trusted[0];
        results.push({
          key: `rakuten:${src.id}`, src, ok: true,
          name: top.itemName || src.label || src.id,
          availability: 'available',
          klass: 'orderable',
          price: top.itemPrice ?? null,
          image: top.mediumImageUrls?.[0]?.imageUrl || top.smallImageUrls?.[0]?.imageUrl || '',
          url: top.itemUrl,
          shopCode: top.shopCode,
        });
      } else {
        results.push({
          key: `rakuten:${src.id}`, src, ok: true,
          name: exact[0]?.itemName || src.label || src.id,
          availability: 'unavailable',
          klass: 'closed',
          price: null,
          image: exact[0]?.mediumImageUrls?.[0]?.imageUrl || '',
          url: `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(src.id)}/`,
        });
      }
    } catch (e) {
      log('rakuten err', src.id, e.message);
      results.push({ key: `rakuten:${src.id}`, src, ok: false, error: e.message });
    }
    await sleep(1100);
  }
  return results;
}

// ---- Discord通知 ----
const STATUS_JA = {
  Now: '在庫あり', IncludesMOQ: '在庫あり(数量条件)', OutOfStock: '在庫切れ',
  PreOrder: '予約受付中', BackOrder: 'お取り寄せ', Discontinued: '販売終了',
  available: '在庫あり (信頼ショップ)', unavailable: '在庫切れ', Unknown: '不明',
};
const PLATFORM_JA = { amazon: 'Amazon', rakuten: '楽天' };
const PLATFORM_COLOR = { amazon: 0xff9900, rakuten: 0xbf0000 };
const statusJa = (v) => STATUS_JA[v] || v;

async function sendDiscord(res, prev, flags) {
  if (!WEBHOOK) { log('[no webhook] would notify', res.key); return; }
  const label = res.src.label || res.name || res.src.id;
  const priceStr = res.price != null ? `¥${Number(res.price).toLocaleString('ja-JP')}` : '—';
  const prevPriceStr = prev?.price != null ? `¥${Number(prev.price).toLocaleString('ja-JP')}` : '—';
  const priceMaxStr = flags.priceMax != null ? `¥${Number(flags.priceMax).toLocaleString('ja-JP')}` : '';

  let content, color;
  const desc = [];
  if (flags.restocked && flags.priceDropped) {
    content = `🎯 **${PLATFORM_JA[res.src.platform]} で復活＋希望価格達成！**`;
    color = 0x8e44ad;
    desc.push(`状態: **${statusJa(prev?.availability)} → ${statusJa(res.availability)}**`);
    desc.push(`価格: ${prevPriceStr} → **${priceStr}** (希望 ≤ ${priceMaxStr})`);
  } else if (flags.restocked) {
    content = `🛒 **${PLATFORM_JA[res.src.platform]} で注文可になりました！**`;
    color = PLATFORM_COLOR[res.src.platform] || 0x2ecc71;
    desc.push(`状態: **${statusJa(prev?.availability)} → ${statusJa(res.availability)}**`);
    desc.push(`価格: ${priceStr}`);
  } else if (flags.priceDropped) {
    content = `💰 **希望価格達成: ${priceMaxStr} 以下になりました！**`;
    color = 0xf39c12;
    desc.push(`価格: ${prevPriceStr} → **${priceStr}** (希望 ≤ ${priceMaxStr})`);
    desc.push(`状態: ${statusJa(res.availability)}`);
  }
  if (res.shopCode) desc.push(`ショップ: ${res.shopCode}`);

  const payload = {
    content,
    embeds: [{
      title: label,
      url: res.url,
      description: desc.join('\n'),
      color,
      ...(res.image ? { thumbnail: { url: res.image } } : {}),
      footer: { text: `${PLATFORM_JA[res.src.platform]} · ${res.src.id}` },
    }],
  };
  try {
    const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    log('discord ->', r.status);
  } catch (e) { log('discord error', e.message); }
}

// ---- メインループ ----
async function tick() {
  await refreshWatchlist(false);
  if (!watch.length) { log('tick: watchlist empty'); return; }
  const amazonItems = watch.filter((i) => i.platform === 'amazon');
  const rakutenItems = watch.filter((i) => i.platform === 'rakuten');
  const results = [
    ...await checkAmazon(amazonItems),
    ...await checkRakuten(rakutenItems),
  ];
  let ord = 0, cls = 0, fail = 0, notifs = 0;
  for (const r of results) {
    if (!r.ok) { fail++; log('fail', r.key, (r.error || '').slice(0, 80)); continue; }
    if (r.klass === 'orderable') ord++;
    if (r.klass === 'closed') cls++;
    const prev = state[r.key];
    const prevKlass = prev?.klass || 'unknown';
    const prevPrice = prev?.price ?? null;
    const priceMax = r.src.priceMax;

    // 通知トリガー判定
    const restocked = prevKlass === 'closed' && r.klass === 'orderable';
    // 価格が閾値を跨いで下がった瞬間だけ通知（既に下ならスパム防止）
    const priceDropped = priceMax != null && r.price != null && r.price <= priceMax
      && prevPrice != null && prevPrice > priceMax;

    if (restocked || priceDropped) {
      await sendDiscord(r, prev, { restocked, priceDropped, priceMax });
      notifs++;
      log('*** NOTIFY', restocked ? '[restock]' : '', priceDropped ? '[price]' : '', r.name);
    }

    // 状態保存：availability か price に変化があれば
    const changed = !prev || prev.availability !== r.availability || (prev.price ?? null) !== (r.price ?? null);
    if (changed) {
      state[r.key] = { availability: r.availability, klass: r.klass, name: r.name, price: r.price ?? null };
      await saveState();
      const priceLog = r.price != null ? `¥${r.price}` : '-';
      log(prevKlass, '->', r.klass, `(${r.availability})`, priceLog, r.name);
    }
  }
  log(`tick: ${watch.length} items (a=${amazonItems.length}, r=${rakutenItems.length}), ${ord} orderable, ${cls} closed, ${fail} fail, ${notifs} notifs`);
}

async function main() {
  if (!WEBHOOK) log('WARN: DISCORD_WEBHOOK_URL 未設定（通知はスキップ）');
  if (!AMAZON_CID && !RAKUTEN_APP_ID) throw new Error('AmazonまたはRakutenの認証情報が必要（.env参照）');
  log('config: amazon=', !!AMAZON_CID, ' rakuten=', !!RAKUTEN_APP_ID, ' interval=', INTERVAL_MS, 'ms');
  await loadState();
  await refreshWatchlist(true);
  log('daemon start, items=', watch.length);
  for (;;) {
    const t0 = Date.now();
    try { await tick(); } catch (e) { log('tick error', e.message); }
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)));
  }
}

process.on('SIGINT', () => { log('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });

main().catch((e) => { console.error(e); process.exit(1); });
