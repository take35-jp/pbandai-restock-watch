// ============================================================================
// プレバン在庫復活ウォッチャー — Cloudflare Workers (Cron) 版
// ----------------------------------------------------------------------------
// Cron Trigger: * * * * *  （1分おき。Cloudflareの最短）
// 必要なバインディング:
//   - KV Namespace を変数名 STATE で割り当て（前回状態の保存に使用）
//   - Secret  DISCORD_WEBHOOK_URL  （Discord Webhook URL）
// watchlist は GitHub の raw から取得 → admin.html の編集がそのまま反映される。
//
// 動作確認: ブラウザで  https://<worker>.workers.dev/?test=1  を開くとDiscordにテスト送信。
// ============================================================================

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const WATCHLIST_URL =
  'https://raw.githubusercontent.com/take35-jp/pbandai-restock-watch/main/watchlist.json';

const ORDERABLE = new Set(['InStock', 'PreOrder', 'BackOrder', 'LimitedAvailability', 'OnlineOnly', 'InStoreOnly']);
const CLOSED = new Set(['OutOfStock', 'SoldOut', 'Discontinued', 'PreSale']);
const STATUS_JA = {
  InStock: '在庫あり', PreOrder: '予約受付中', BackOrder: 'お取り寄せ',
  LimitedAvailability: '数量限定', OnlineOnly: 'ネット限定', InStoreOnly: '店頭限定',
  OutOfStock: '受付終了/売切', SoldOut: '売切', Discontinued: '販売終了',
  PreSale: '販売前', unknown: '不明',
};

function classify(av) {
  if (ORDERABLE.has(av)) return 'orderable';
  if (CLOSED.has(av)) return 'closed';
  return 'unknown';
}

// 商品名表示用にShift_JISを試す。未対応ならUTF-8へフォールバック
// （availability判定はASCIIなのでどちらでも壊れない）
function decodeBody(buf) {
  try { return new TextDecoder('shift_jis').decode(buf); }
  catch { return new TextDecoder('utf-8').decode(buf); }
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
  const buf = await r.arrayBuffer();
  const info = parseProduct(decodeBody(buf));
  if (!info) return { ok: false, noLd: true };
  return { ok: true, ...info };
}

async function notify(env, item, info, prevAv) {
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
  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
}

async function runCheck(env) {
  // watchlist 取得
  let watch = [];
  try {
    const r = await fetch(WATCHLIST_URL, { cf: { cacheTtl: 0 }, headers: { 'User-Agent': UA } });
    if (!r.ok) { console.log('watchlist status', r.status); return; }
    watch = (await r.json())
      .map((x) => (typeof x === 'string' ? { url: x, label: '' } : { url: x.url || '', label: x.label || '' }))
      .filter((x) => x.url);
  } catch (e) { console.log('watchlist error', e.message); return; }

  // 前回状態
  let state = {};
  try { const s = await env.STATE.get('state'); if (s) state = JSON.parse(s); } catch (e) { /* 初回 */ }

  let changed = false;
  for (const item of watch) {
    try {
      const info = await fetchItem(item.url);
      if (!info.ok) { console.log('skip', item.url, info.status || (info.noLd ? 'noLd' : '')); continue; }
      const klass = classify(info.availability);
      const prev = state[item.url];
      const prevKlass = prev?.klass || 'unknown';
      if (prevKlass === 'closed' && klass === 'orderable') {
        await notify(env, item, info, prev.availability);
        console.log('NOTIFY', prev.availability, '->', info.availability, info.name);
      }
      if (!prev || prev.availability !== info.availability) {
        state[item.url] = { availability: info.availability, klass, name: info.name };
        changed = true;
        console.log(prevKlass, '->', klass, info.availability, info.name);
      }
    } catch (e) { console.log('item error', item.url, e.message); }
  }
  // ハートビート: 毎回必ず1行出すので「Workerが生きてるか」をログで確認できる
  const ordC = Object.values(state).filter((s) => s?.klass === 'orderable').length;
  const closC = Object.values(state).filter((s) => s?.klass === 'closed').length;
  console.log(`tick: ${watch.length} items, ${ordC} orderable, ${closC} closed, changed=${changed}`);
  if (changed) await env.STATE.put('state', JSON.stringify(state)); // 変化時のみ書き込み（KV書込上限対策）
}

export default {
  // Cron で1分おきに呼ばれる（awaitで確実に完了させる）
  async scheduled(event, env, ctx) {
    await runCheck(env);
  },
  // 手動疎通確認用:  /?test=1 でDiscordにテスト送信、/ で状態表示
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.searchParams.get('test') === '1') {
      if (!env.DISCORD_WEBHOOK_URL) return new Response('DISCORD_WEBHOOK_URL 未設定', { status: 500 });
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '✅ Cloudflare Worker 疎通テストOK' }),
      });
      return new Response('Discordにテスト送信しました');
    }
    if (u.searchParams.get('run') === '1') { await runCheck(env); return new Response('チェックを1回実行しました（ログ参照）'); }
    if (u.searchParams.get('force-notify') === '1') {
      // 通知パイプライン全体（notify関数）をテスト実行する
      try {
        const wlR = await fetch(WATCHLIST_URL, { cf: { cacheTtl: 0 }, headers: { 'User-Agent': UA } });
        const wl = (await wlR.json())
          .map((x) => (typeof x === 'string' ? { url: x, label: '' } : { url: x.url || '', label: x.label || '' }))
          .filter((x) => x.url);
        if (!wl.length) return new Response('watchlist が空', { status: 500 });
        const item = wl[0];
        const info = await fetchItem(item.url);
        if (!info.ok) return new Response('item取得失敗: ' + (info.status || 'noLd'), { status: 500 });
        await notify(env, item, info, 'OutOfStock'); // 擬似的に「OutOfStock→現在状態」として発火
        return new Response('🧪 擬似通知を送信: ' + (info.name || item.url));
      } catch (e) { return new Response('error: ' + e.message, { status: 500 }); }
    }
    return new Response('プレバン在庫ウォッチャー (Cron稼働中)。?test=1=Discord疎通テスト、?run=1=即チェック、?force-notify=1=通知パイプラインの擬似発火');
  },
};
