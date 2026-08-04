"use client";

// Service Worker の登録（Android アプリ化 T1・PWA 化）。
// 正本: 02_プロジェクト/TV_MVP-android/ARCHITECTURE.md §3-5
//
// 副作用専用のコンポーネントで、DOM は一切描画しない（null を返す）。
// ルートレイアウトの <body> 内に1箇所だけ置くことで、6ページすべてを1箇所でカバーし、
// 各ページ（いずれも "use client" の巨大なファイル）に手を入れずに済む。
//
// 登録は window の load イベント後に行う。待受アルバム動画の DL を 5 秒遅延させているのと
// 同じ理由（ALBUM_INITIAL_DEFER_MS のコメント参照）で、初期表示とネットワーク帯域を
// 奪い合わせないため。SWA Free プランは静的アセットを 40〜70KB/s に throttle するため、
// 初期表示より先に sw.js を取りにいかせない。
//
// **登録に失敗してもアプリが壊れないこと**が要件。非対応ブラウザ・非セキュアコンテキスト・
// register() の reject はすべて握りつぶし、通常のネットワーク動作へフォールバックする
// （本 SW は /_next/static/ の cache-first しか行わないため、登録できなくても機能欠損はない）。
//
// data-testid は追加しない（既存の維持が T1 の DoD）。

import { useEffect } from "react";
import { startServiceWorkerUpdates } from "../modules/swUpdateScheduler";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    // SSR / 静的エクスポートのビルド時、および非対応環境では何もしない。
    if (typeof window === "undefined") return;
    if (typeof navigator === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Service Worker はセキュアコンテキスト（https / localhost）でのみ動く。
    // 非セキュアで register() を呼ぶと例外になるため、事前に弾く。
    if (!window.isSecureContext) return;

    let cancelled = false;
    let stopUpdates: (() => void) | null = null;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          // アンマウント後に解決した場合はタイマーを張らない。
          if (cancelled) return;
          // 無人待受端末はナビゲーションが起きず、ブラウザ既定の更新契機を踏まない。
          // 1 時間ごとに update() を呼び、sw.js の修正が届く経路を自前で作る（T4 M-6）。
          // 根拠と設計は modules/swUpdateScheduler.ts を参照。
          stopUpdates = startServiceWorkerUpdates(registration);
        })
        .catch(() => {
          // 登録失敗はアプリの機能に影響しないため、握りつぶす。
        });
    };

    // load 済みなら即座に、未了なら load を待って登録する
    // （effect が load 後に走るケースでは load イベントが二度と来ないため）。
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register);
    }

    return () => {
      cancelled = true;
      if (stopUpdates) stopUpdates();
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
