// ストレージ永続化の申請（Storage API）— 高齢者側の待受画面専用。
// 正本: 02_プロジェクト/TV_MVP-android/ARCHITECTURE.md §0 P5 ／ T4 悲観レビュー M-3。
//
// なぜ要るか:
//  - デバイス登録は **localStorage["device_token"]** に保存されている。これが消えると
//    待受は「まだ とうろく されていません」に落ち、家族が再登録リンクを踏むまで着信を
//    受けられない（＝無人端末が人手なしでは戻れない）。
//  - localStorage と Cache Storage は**オリジン単位の同じ quota** を共有する。SW が
//    /_next/static/ を貯め続ける以上、ストレージ逼迫時の eviction は両者をまとめて奪う。
//  - navigator.storage.persist() が許可されると、そのオリジンは eviction の対象外になる。
//    Chrome はインストール済み PWA / TWA には自動的に許可するため、待受端末（TWA）では
//    プロンプトも出ずに通る見込み。
//
// 申請は **best-effort**。非対応ブラウザ・拒否・例外はすべて握りつぶし、待受の動作には
// 一切影響させない（Wake Lock と同じ方針）。
//
// テスト容易性のため navigator を引数で差し替えられるようにしている
// （tests-unit は node 環境で navigator.storage を持たないため）。

/** navigator.storage の必要な部分だけ。 */
export interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

export interface PersistentStorageNavigatorLike {
  storage?: StorageManagerLike;
}

/** 差し替え可能な依存（テスト用）。省略時は実グローバルを使う。 */
export interface PersistentStorageEnv {
  navigator?: PersistentStorageNavigatorLike;
}

function resolveNavigator(
  env?: PersistentStorageEnv
): PersistentStorageNavigatorLike | undefined {
  if (env?.navigator) return env.navigator;
  if (typeof navigator === "undefined") return undefined;
  return navigator as unknown as PersistentStorageNavigatorLike;
}

/**
 * ストレージの永続化を申請する。
 *
 * - すでに永続化されていれば `persist()` を呼ばずに `true` を返す（無駄な申請をしない）。
 * - 申請できた場合は許可結果（`true` / `false`）を返す。
 * - 非対応・例外の場合は `null` を返す（呼び出し側は無視してよい）。
 *
 * @param env テスト用の依存差し替え（省略時は実グローバル）
 */
export async function requestPersistentStorage(
  env?: PersistentStorageEnv
): Promise<boolean | null> {
  const storage = resolveNavigator(env)?.storage;
  if (!storage) return null;
  try {
    if (typeof storage.persisted === "function") {
      const already = await storage.persisted();
      if (already) return true;
    }
    if (typeof storage.persist !== "function") return null;
    return await storage.persist();
  } catch {
    // 申請できないこと自体は障害ではない。待受の動作には影響させない。
    return null;
  }
}
