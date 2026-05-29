// ============================================================================
// プレバン在庫復活ウォッチャー（自分用 / 通知のみ・購入は人間）
// ----------------------------------------------------------------------------
// 役割: watchlist.json に登録した商品ページを巡回し、
//       「注文不可(OutOfStock等) → 注文可(InStock/PreOrder等)」に
//       変化した瞬間だけ Discord に通知する。
//
// 設計メモ:
//   - 判定は商品ページ内の JSON-LD `@type:"Product"` の
//     offers.availability（schema.org 語彙）だけを見る。これが本体の唯一正。
//     ※ページには関連商品の availability も混ざるので、生のHTML文字列検索は誤判定する。
//   - プレバンの商品ページは Shift_JIS。商品名表示のため必ずデコードする。
//   - robots.txt 準拠: /item/ はクロール可、/search/ は禁止 → 検索はしない。
//   - 良識的な巡回: リクエスト間に 1.5 秒スリープ。少数監視（自分用）前提。
//   - エッジ検知: state.json に前回状態を保存し、closed→orderable の変化のみ通知。
//     初回観測 / unknown 起点は baseline 扱いで通知しない（スパム防止）。
//
// 実行:
//   ローカル(PowerShell): $env:DISCORD_WEBHOOK_URL='...'; node restock-watch/watch.mjs
//   Webhook 動作確認:                                     node restock-watch/watch.mjs --test
//   GitHub Actions:        5分おきに自動実行（workflow.yml 参照）
// ============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST = path.join(DIR, 'watchlist.json');
const STATE = path.join(DIR, 'state.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const REQUEST_GAP_MS = 1500;

// schema.org availability の分類 ----------------------------------------------
const ORDERABLE = new Set([
  'InStock', 'PreOrder', 'BackOrder', 'LimitedAvailability',
  'OnlineOnly', 'InStoreOnly',
]);
const CLOSED = new Set([
  'OutOfStock', 'SoldOut', 'Discontinued', 'PreSale',
]);
// PreSale(発売前) は安全側に倒して「注文不可」扱い → 受付開始で通知が飛ぶ。

const STATUS_JA = {
  InStock: '在庫あり', PreOrder: '予約受付中', BackOrder: 'お取り寄せ',
  LimitedAvailability: '数量限定', OnlineOnly: 'ネット限定', InStoreOnly: '店頭限定',
  OutOfStock: '受付終了/売切', SoldOut: '売切', Discontinued: '販売終了',
  PreSale: '販売前', unknown: '不明',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(av) {
  if (ORDERABLE.has(av)) return 'orderable';
  if (CLOSED.has(av)) return 'closed';
  return 'unknown';
}

// 商品ページHTMLから本体Productの状態を抽出 ----------------------------------
function parseProduct(html) {
  const blocks = [
    ...html.matchAll(
      /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g
    ),
  ].map((m) => m[1]);
  for (const b of blocks) {
    let data;
    try { data = JSON.parse(b); } catch { continue; }
    for (const node of Array.isArray(data) ? data : [data]) {
      if (node && node['@type'] === 'Product') {
        let offers = node.offers;
        if (Array.isArray(offers)) offers = offers[0];
        const av = (offers?.availability || '')
          .replace(/^https?:\/\/schema\.org\//, '');
        const image = typeof node.image === 'string'
          ? node.image
          : Array.isArray(node.image) ? node.image[0] : '';
        return {
          name: node.name || '',
          image,
          price: offers?.price || '',
          availability: av || 'unknown',
        };
      }
    }
  }
  return null;
}

async function fetchItem(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.9' },
    redirect: 'follow',
  });
  if (!r.ok) return { ok: false, status: r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  const html = new TextDecoder('shift_jis').decode(buf);
  const info = parseProduct(html);
  if (!info) return { ok: false, status: r.status, noLd: true };
  return { ok: true, status: r.status, ...info };
}

async function sendDiscord(payload) {
  if (!WEBHOOK) {
    console.log('[no DISCORD_WEBHOOK_URL] skipped:', JSON.stringify(payload).slice(0, 120));
    return;
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  console.log('discord ->', res.status);
}

function notifyPayload(item, info, prevAv) {
  const label = info.name || item.label || item.url;
  const price = info.price ? `¥${Number(info.price).toLocaleString('ja-JP')}` : '—';
  return {
    content: '🛒 **プレバンで注文可になりました！**',
    embeds: [{
      title: label,
      url: item.url,
      description:
        `状態: **${STATUS_JA[prevAv] || prevAv} → ${STATUS_JA[info.availability] || info.availability}**\n` +
        `価格: ${price}`,
      color: 0x2ecc71,
      ...(info.image ? { thumbnail: { url: info.image } } : {}),
    }],
  };
}

async function main() {
  // --test: Webhook 疎通確認だけして終了
  if (process.argv.includes('--test')) {
    await sendDiscord({ content: '✅ プレバン在庫復活ウォッチャー: Webテスト送信OK' });
    return;
  }

  const watch = JSON.parse(await readFile(WATCHLIST, 'utf8'));
  let state = {};
  try { state = JSON.parse(await readFile(STATE, 'utf8')); } catch { /* 初回 */ }

  let changed = false;
  for (const entry of watch) {
    const item = typeof entry === 'string' ? { url: entry } : entry;
    if (!item?.url) continue;
    try {
      const info = await fetchItem(item.url);
      if (!info.ok) {
        console.log(`skip (status ${info.status}${info.noLd ? ', no JSON-LD' : ''})`, item.url);
        await sleep(REQUEST_GAP_MS);
        continue;
      }
      const klass = classify(info.availability);
      const prev = state[item.url];
      const prevKlass = prev?.klass || 'unknown';

      // ▼ 通知するのは「閉→開」エッジのみ
      if (prevKlass === 'closed' && klass === 'orderable') {
        await sendDiscord(notifyPayload(item, info, prev.availability));
        console.log(`*** NOTIFY ${prev.availability} -> ${info.availability}`, info.name);
      }

      if (!prev || prev.availability !== info.availability) {
        state[item.url] = { availability: info.availability, klass, name: info.name };
        changed = true;
        console.log(`${prevKlass} -> ${klass} (${info.availability})`, info.name || item.url);
      } else {
        console.log(`= ${klass} (${info.availability})`, info.name || item.url);
      }
    } catch (e) {
      console.log('ERR', item.url, e.message);
    }
    await sleep(REQUEST_GAP_MS);
  }

  if (changed) await writeFile(STATE, JSON.stringify(state, null, 2) + '\n');
  console.log('done. stateChanged =', changed);
}

main().catch((e) => { console.error(e); process.exit(1); });
