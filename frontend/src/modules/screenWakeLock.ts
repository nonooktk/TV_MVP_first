// 画面消灯の抑止（Screen Wake Lock API）— 高齢者側の待受画面専用。
// 正本: 02_プロジェクト/TV_MVP-android/ARCHITECTURE.md §7
//
// 待受端末は常時給電で無人稼働し、着信に気づけることが唯一の役目なので、画面が消えては
// 困る。ここでは「開始 → 停止関数を返す」形にまとめ、待受ページからは useEffect 1本で
// 呼べるようにしている（戻り値をそのままクリーンアップに渡せる）。
//
// 設計上の判断:
//  - **フェーズ（standby / incoming / in_call）に依存させない**。通話中こそ画面が消えては
//    困るうえ、フェーズごとに取得・解放を書き分けると解放漏れ・再取得漏れの組み合わせが
//    増える。マウント〜アンマウントの通し1本が最も壊れにくい。
//  - **visibilitychange での再取得は必須**（任意の最適化ではない）。W3C Screen Wake Lock
//    API §11.3 が「visibility が hidden に遷移したら UA が保持中のロックを解放する」と
//    規定しているため、再取得しないと一度タブが隠れただけで永久に効かなくなる。
//  - **非対応・失敗はすべて握りつぶす**。request() は Secure Context でない・document が
//    hidden・省電力モード等で NotAllowedError を投げうる。Wake Lock は「取れたら嬉しい」
//    機能であって、取れないことで画面が壊れてはならない。
//  - **失敗したら一定間隔で取り直す**（T4 悲観レビュー M-4）。再取得の契機が
//    visibilitychange だけだと、可視のまま何日も放置される待受端末では「一度失敗したら
//    終わり」になる。Android のバッテリーセーバーは Wake Lock の取得を拒否するが充電開始で
//    解除されるため、その復帰を拾える契機が必要。常時給電の据置端末なので、60 秒間隔の
//    素朴なリトライで足りる（取得できたら即座にタイマーを止める）。
//
// なお仕様上 **ユーザーアクティベーション（クリック等）は不要**なので、待受ページの
// マウント直後に取得してよい（「でる」を押すまで待つ必要はない）。
//
// テスト容易性のため、navigator / document を引数で差し替えられるようにしている
// （tests-unit は node 環境で DOM を持たないため）。省略時は実グローバルを使う。

/** Wake Lock の保持証（W3C WakeLockSentinel の必要な部分だけ）。 */
export interface WakeLockSentinelLike {
  /** UA が解放済みかどうか。実装によっては提供されない。 */
  readonly released?: boolean;
  release(): Promise<void> | void;
  addEventListener(type: "release", listener: () => void): void;
}

/** navigator.wakeLock の必要な部分だけ。 */
export interface WakeLockApiLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export interface WakeLockNavigatorLike {
  wakeLock?: WakeLockApiLike;
}

export interface WakeLockDocumentLike {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** 差し替え可能な依存（テスト用）。省略時は実グローバルを使う。 */
export interface ScreenWakeLockEnv {
  navigator?: WakeLockNavigatorLike;
  document?: WakeLockDocumentLike;
}

/** 何もしない停止関数（非対応環境で返す）。 */
const NOOP = () => {};

/** 取得に失敗したあと、再取得を試みる間隔（ミリ秒）。 */
export const WAKE_LOCK_RETRY_INTERVAL_MS = 60_000;

function resolveNavigator(
  env?: ScreenWakeLockEnv
): WakeLockNavigatorLike | undefined {
  if (env?.navigator) return env.navigator;
  if (typeof navigator === "undefined") return undefined;
  return navigator as unknown as WakeLockNavigatorLike;
}

function resolveDocument(
  env?: ScreenWakeLockEnv
): WakeLockDocumentLike | undefined {
  if (env?.document) return env.document;
  if (typeof document === "undefined") return undefined;
  return document as unknown as WakeLockDocumentLike;
}

/**
 * 画面消灯の抑止を開始する。
 *
 * - 開始時、document が可視なら即座に取得を試みる。
 * - 以後 visibilitychange で可視に戻るたびに再取得する（hidden 中は UA が自動解放するため）。
 * - 戻り値の停止関数でリスナーを外し、保持中なら解放する。
 *
 * 非対応（navigator.wakeLock が無い）・document が取れない場合は、
 * **何も登録せずに no-op の停止関数を返す**。
 *
 * @param env テスト用の依存差し替え（省略時は実グローバル）
 * @returns 停止関数（useEffect のクリーンアップにそのまま渡せる）
 */
export function startScreenWakeLock(env?: ScreenWakeLockEnv): () => void {
  const nav = resolveNavigator(env);
  const doc = resolveDocument(env);
  const api = nav?.wakeLock;

  // 非対応環境では機能を諦めるだけで、画面は壊さない。
  if (!api || !doc) return NOOP;

  let stopped = false;
  let sentinel: WakeLockSentinelLike | null = null;
  // request() の解決待ち中に visibilitychange が重なっても二重取得しないためのフラグ。
  let acquiring = false;
  // 取得失敗後の再試行タイマー（保持できたら止める）。
  let retryTimer: ReturnType<typeof setInterval> | null = null;

  const clearRetry = () => {
    if (retryTimer === null) return;
    clearInterval(retryTimer);
    retryTimer = null;
  };

  // 取得に失敗したときだけ動かす定期リトライ（M-4）。
  // 待受端末は可視のまま放置されるため、visibilitychange に依存しない契機がここだけになる。
  const scheduleRetry = () => {
    if (stopped || retryTimer !== null) return;
    retryTimer = setInterval(() => {
      if (stopped || sentinel) {
        clearRetry();
        return;
      }
      void acquire();
    }, WAKE_LOCK_RETRY_INTERVAL_MS);
  };

  const releaseSentinel = (target: WakeLockSentinelLike) => {
    try {
      // release() は Promise を返す実装が主だが、同期実装も許容して包む。
      Promise.resolve(target.release()).catch(() => {
        // 解放失敗は復旧のしようがなく、実害も無いので握りつぶす。
      });
    } catch {
      // 同期 throw も同様に握りつぶす。
    }
  };

  const acquire = async () => {
    if (stopped || acquiring) return;
    // 既に保持中なら何もしない。ただし UA が release イベントを出さずに解放していた場合に
    // 備え、released フラグが立っていれば取り直す。
    if (sentinel) {
      if (sentinel.released !== true) return;
      sentinel = null;
    }
    // hidden 中の request() は仕様上 NotAllowedError になるため、そもそも呼ばない。
    if (doc.visibilityState === "hidden") return;

    acquiring = true;
    try {
      const acquired = await api.request("screen");
      if (stopped) {
        // 解決した時点で既に停止していたら、掴まず即座に解放する（取りっぱなし防止）。
        releaseSentinel(acquired);
        return;
      }
      sentinel = acquired;
      // 保持できたのでリトライは不要（UA が解放したら release イベントで参照が戻り、
      // 次の契機〈可視復帰またはリトライ再開〉で取り直す）。
      clearRetry();
      // UA 側の解放（hidden 遷移・省電力など）を検知して内部参照を戻す。
      // これが無いと、次に可視へ戻ったとき「保持中」と誤認して再取得できない。
      acquired.addEventListener("release", () => {
        if (sentinel === acquired) sentinel = null;
      });
    } catch {
      // NotAllowedError 等。Wake Lock を諦めるだけで、待受の動作には影響させないが、
      // 諦めっぱなしにはしない（省電力モード解除などで後から取れるようになるため）。
      scheduleRetry();
    } finally {
      acquiring = false;
    }
  };

  const onVisibilityChange = () => {
    // 可視に戻ったら取り直す。hidden 側では何もしない
    // （UA が自動解放し、release イベントで内部参照が null に戻る）。
    if (doc.visibilityState === "visible") void acquire();
  };

  doc.addEventListener("visibilitychange", onVisibilityChange);
  void acquire();

  return () => {
    if (stopped) return;
    stopped = true;
    clearRetry();
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    const held = sentinel;
    sentinel = null;
    if (held) releaseSentinel(held);
  };
}
