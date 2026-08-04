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
 */

const CACHE_VERSION = "omohide-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

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
    event.respondWith(cacheFirst(request));
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
async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.status === 200) {
    cache.put(request, response.clone());
  }
  return response;
}

// network-first（ナビゲーション用）: 常にネットワーク優先。**成功応答は保存しない**。
// 失敗時のみ、パスに応じたフォールバック HTML を返す。
async function networkFirstNavigation(request, path) {
  try {
    return await fetch(request);
  } catch {
    return offlineFallback(path);
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
