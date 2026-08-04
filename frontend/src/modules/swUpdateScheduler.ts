// Service Worker の定期更新（T4 悲観レビュー M-6）。
// 正本: 02_プロジェクト/TV_MVP-android/ARCHITECTURE.md §3-7。
//
// ブラウザが新しい sw.js を取りに行く契機は、①スコープ内のナビゲーション、②前回チェックから
// 24 時間以上経過した状態での functional event の2つしかない。ところが待受端末は
//  - 数日単位でナビゲーションが発生せず（ページを開きっぱなしにする運用）、
//  - 着信ポーリングは**別オリジン**の API 呼び出しなので SW の fetch イベントすら発火しない
// ため、どちらの契機も踏まない。結果として「SW だけは先に新しくなる」は無人待受端末では
// 成立せず、sw.js の修正が端末再起動まで届かない。
//
// そこで登録後の registration を保持し、一定間隔で update() を呼んで更新契機を自前で作る。
// これが無人端末に SW の修正を届ける唯一の自動経路になる。
//
// 失敗（オフライン・オリジン障害）は握りつぶす。次の周期でまた試せばよく、
// 待受の動作に影響させてはならない。

/** 更新チェックの間隔（ミリ秒）。1 時間ごと。 */
export const SW_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

/** ServiceWorkerRegistration の必要な部分だけ（テスト差し替え用）。 */
export interface ServiceWorkerRegistrationLike {
  update(): Promise<unknown>;
}

/**
 * SW の定期更新チェックを開始する。
 *
 * @param registration `navigator.serviceWorker.register()` の解決値
 * @param intervalMs チェック間隔（省略時 1 時間）
 * @returns 停止関数（useEffect のクリーンアップにそのまま渡せる）
 */
export function startServiceWorkerUpdates(
  registration: ServiceWorkerRegistrationLike,
  intervalMs: number = SW_UPDATE_INTERVAL_MS
): () => void {
  const timer = setInterval(() => {
    try {
      void Promise.resolve(registration.update()).catch(() => {
        // 更新チェックの失敗は次の周期で回復する。
      });
    } catch {
      // 同期 throw（登録が失効している等）も同様に握りつぶす。
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
