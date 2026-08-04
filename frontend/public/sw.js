/*
 * おもひでてれび Service Worker（Android アプリ化 T1・PWA 化）
 *
 * 設計正本: 02_プロジェクト/TV_MVP-android/ARCHITECTURE.md §3。
 * 先例知見: 01_ナレッジ/Web/service-worker-conservative-caching（りなれす sw.js）。
 *
 * 方針は「介入範囲を極端に狭くする」こと。スコープはオリジンルート `/` だが、
 * 実際に respondWith するのは次の2つだけで、それ以外は一切介入しない。
 *
 *  1. /_next/static/ … ビルドごとにハッシュが変わる＝内容不変の静的アセットのみ cache-first。
 *  2. HTML ナビゲーション … network-first。**成功応答をキャッシュに保存しない**。
 *     失敗時のみ SW 内蔵のフォールバック HTML（下記）を返す。
 *
 * 触らないもの（respondWith を呼ばない）:
 *  - API / Agora / Blob SAS / Azure Speech / MediaPipe CDN … いずれも別オリジンなので
 *    同一オリジン判定だけで自動的に対象外になる。
 *  - /mediapipe/（ローカル fallback 22MB）・/sounds/（Range リクエスト）・
 *    /manifest 系・/.well-known/（TWA の assetlinks 検証経路）。
 *
 * precache しない（install で何もフェッチしない）。初回訪問時の追加ダウンロードをゼロに
 * するための意図的な設計で、SW 導入による帯域の増分は sw.js 自体（数 KB）のみ。
 * SWA Free プランは静的アセットを 40〜70KB/s に throttle するため、初期表示を悪化させない
 * ことが非機能要件になっている。
 *
 * HTML をキャッシュに保存しない理由: 静的エクスポートの HTML はハッシュ付きの
 * /_next/static/ チャンクを参照するため、デプロイ後に古い HTML を返すと参照先チャンクが
 * 存在せず白画面になる。白画面は再読み込みの導線が無く、無人稼働する待受端末では
 * ブラウザのエラーページより回復手段が乏しい。
 *
 * CACHE_VERSION を上げる基準（りなれすの運用メモと同じ）:
 *  - 上げる: 本ファイルのキャッシュ戦略（対象パス・方式）を変えたとき。
 *  - 上げない: 日常のデプロイ。/_next/static/ はファイル名のハッシュが変わるため、
 *    据え置いても古いアセットが誤って再利用されることはない。
 *
 * T4 悲観レビュー（クロミ）指摘の反映（2026-08-04）:
 *  - M-1: fetch() は HTTP エラーステータスでは reject しない。5xx をそのまま返すと
 *    無人待受端末がオリジンのエラーページを表示したまま停止するため、明示的に判定する。
 *  - M-2: 応答が返らない回線ではフォールバックにも到達しないため、AbortController で
 *    10 秒のタイムアウトを設ける。
 *  - M-3: /_next/static/ キャッシュの上限管理（古い順に削除）を入れる。
 *    **この変更で CACHE_VERSION は上げない**。キャッシュ名を変えると、開きっぱなしの
 *    待受端末が参照している旧チャンクを activate が全消去してしまい（m-5）、
 *    SWA 上に旧ハッシュのファイルが無いぶん実害が出るため。対象パスも方式も変えず、
 *    同じキャッシュに上限を足すだけの後方互換な変更である。
 */

const CACHE_VERSION = "omohide-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

// ナビゲーションのネットワーク待ちの上限（M-2）。Wi-Fi には繋がっているが応答が返らない
// 状態（キャプティブポータル・回線の瀕死・オリジンのハング）は屋内据置端末で最も起きやすい
// 劣化パターンで、fetch は例外を投げないため放置すると画面が空白のまま固まる。
const NAVIGATION_TIMEOUT_MS = 10000;

// /_next/static/ キャッシュに保持するエントリ数の上限（M-3）。
// デプロイのたびに新しいハッシュのチャンクが積み増されるため、上限が無いと
// オリジン単位の quota を食いつぶし、同じ quota を共有する localStorage
// （device_token）が eviction で消えうる。1 デプロイあたり 20 本前後なので、
// 200 件はおよそ 10 デプロイぶんの余裕にあたる。
const MAX_STATIC_ENTRIES = 200;

// インストール即時、新しい SW を有効化（待機させない）。precache は行わない。
self.addEventListener("install", () => {
  self.skipWaiting();
});

// 有効化時に、当バージョン以外のキャッシュを削除してからクライアントを掌握する。
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE)
          .map((key) => caches.delete(key)),
      );
      // 既に上限を超えて肥大したキャッシュを持つ端末を、SW 更新の機会に掃除する（M-3）。
      // 上限管理を入れる前に育ったキャッシュは put のたびの削除だけでは減らないため、
      // ここでも一度均す。失敗しても activate は止めない。
      try {
        await trimStaticCache(await caches.open(STATIC_CACHE));
      } catch {
        // 掃除できなくても既存の動作には影響しない。
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // 1. GET 以外（POST 等）は介入しない。
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 2. 別オリジン（API / Agora / Blob SAS / Azure Speech / jsDelivr / accounts.google.com 等）。
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // 3. API。現状 API は別オリジンだが、将来 rewrite で同一オリジンに載せた場合の多重防御。
  if (path.startsWith("/api/")) return;

  // 4. MediaPipe のローカル fallback（22MB）。Cache Storage に入れてはならない。
  if (path.startsWith("/mediapipe/")) return;

  // 5. 着信音などの音声。Range リクエスト対応の複雑さに見合わない。
  if (path.startsWith("/sounds/")) return;

  // 6. SW 自体・manifest・assetlinks。HTTP キャッシュ制御（staticwebapp.config.json の
  //    no-cache）に委ね、SW が古い応答を挟まないようにする。
  if (
    path === "/sw.js" ||
    path === "/manifest.webmanifest" ||
    path === "/elder.webmanifest" ||
    path.startsWith("/.well-known/")
  ) {
    return;
  }

  // 7. ハッシュ付き静的アセットのみ cache-first。
  if (path.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, event));
    return;
  }

  // 8. HTML ナビゲーションは network-first（保存しない・失敗時のみフォールバック）。
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request, path));
    return;
  }

  // 9. それ以外（/icons/・/brand/・/staticwebapp.config.json 等）は介入せず
  //    HTTP キャッシュに委ねる。
});

// cache-first: キャッシュヒットなら即返す。ミス時は取得し、200 のときだけ保存する
// （opaque 応答〈status 0〉やエラー応答をキャッシュに混入させない）。
//
// 保存と上限管理は応答を待たせずに行う（画面表示を1ミリ秒も遅らせない）。ただし
// event.waitUntil で SW の寿命に紐づけ、respondWith 後に処理が打ち切られないようにする。
async function cacheFirst(request, event) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.status === 200) {
    const store = cache
      .put(request, response.clone())
      .then(() => trimStaticCache(cache))
      // quota 超過（QuotaExceededError）はここで握りつぶす。キャッシュに入らなくても
      // ネットワークから取得できているので画面は成立する（未処理の Promise 拒否も防ぐ）。
      .catch(() => {});
    if (event) event.waitUntil(store);
  }
  return response;
}

// /_next/static/ キャッシュのエントリ数を上限内に収める（M-3）。
//
// Cache Storage の keys() は**挿入順**を返すため、先頭ほど古い（＝古いデプロイの
// チャンク）。開きっぱなしの端末が今まさに参照しているのは新しいチャンク側なので、
// 古い順に落とすのが最も安全な削り方になる。
async function trimStaticCache(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - MAX_STATIC_ENTRIES;
  if (overflow <= 0) return;
  await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
}

// network-first（ナビゲーション用）: 常にネットワーク優先。**成功応答は保存しない**。
// 失敗時のみ、パスに応じたフォールバック HTML を返す。
//
// 「失敗」は3種類ある。いずれも無人待受端末を自動復帰させるためにフォールバックへ落とす。
//  (a) ネットワーク例外（機内モード・電波断） … fetch が reject する。
//  (b) オリジンの 5xx（SWA 障害・デプロイ中）  … fetch は **reject しない**ので status で判定する。
//  (c) 応答が返らない（回線の瀕死・ハング）   … AbortController のタイムアウトで打ち切る。
// フォールバック HTML の meta refresh が 30 秒ごとに再試行するため、回線やオリジンが
// 戻れば人手を介さず待受へ復帰する。
//
// 4xx はフォールバックに落とさない。`/elder/register/?token=...` の 404 まで
// 「つうしんが つながりません」にすると、原因の切り分けができなくなるため。
async function networkFirstNavigation(request, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.status >= 500) return offlineFallback(path);
    return response;
  } catch {
    // ネットワーク例外、およびタイムアウトによる AbortError。
    return offlineFallback(path);
  } finally {
    // 応答ヘッダが確定した時点で必ず解除する。解除しないと、本文のストリーミング中に
    // abort が走ってページが途中で切れる。
    clearTimeout(timer);
  }
}

// オフライン時のフォールバック HTML。
//
// SW が合成した Response にはサーバーの CSP ヘッダが付かないため、外部リソースを一切
// 参照しない（インラインスタイルのみ・画像なし・JS なし）で単体完結させる。
function offlineFallback(path) {
  const isElder = path.startsWith("/elder/");
  const html = isElder ? ELDER_OFFLINE_HTML : FAMILY_OFFLINE_HTML;
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// 高齢者側（/elder/*）: 墨色地・大きなひらがな。
// meta refresh で 30 秒ごとに自動再試行する。待受端末は無人で稼働するため、通信が
// 復帰したときに人手を介さず待受へ戻れることが必要（JS を使わず meta だけで実現する）。
const ELDER_OFFLINE_HTML =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta http-equiv="refresh" content="30">' +
  "<title>おもひでてれび</title></head>" +
  '<body style="margin:0;background:#33302b;color:#f8f2e4;display:flex;' +
  "min-height:100vh;align-items:center;justify-content:center;text-align:center;" +
  'padding:4vw;font-family:serif;line-height:1.8;">' +
  "<div><p style=\"font-size:6vw;margin:0 0 4vw;\">つうしんが つながりません</p>" +
  '<p style="font-size:4vw;margin:0;">そのままで おまちください</p></div>' +
  "</body></html>";

// 家族側: 和紙地・墨色文字。手元で操作している前提なので自動再読み込みは入れない。
const FAMILY_OFFLINE_HTML =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<title>おもひでてれび</title></head>" +
  '<body style="margin:0;background:#f2ebdc;color:#241f1c;display:flex;' +
  "min-height:100vh;align-items:center;justify-content:center;text-align:center;" +
  'padding:24px;font-family:serif;line-height:1.9;">' +
  '<div><p style="font-size:18px;margin:0 0 12px;">通信につながりませんでした</p>' +
  '<p style="font-size:15px;margin:0;">通信環境を確認して、もう一度お試しください。</p></div>' +
  "</body></html>";
