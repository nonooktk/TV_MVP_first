// 待受アルバム自動ループ再生の「差し替え判定」「エラー時再取得」の純粋ロジック（機能B・B-2）。
//
// 高齢者側 TV の待受画面は、最新ハイライト動画（GET /albums/latest の video_sas_url）を
// 全画面背景で自動ループ再生する。以下を純粋関数として切り出し、vitest で単体検証する
// （React 状態や DOM に依存させない）。
//
// - nextOnPoll: 60秒ごとの定期確認で「src を差し替えるべき新しい再生対象」を決める。
//   同一アルバム（id/version 一致）なら null を返して src を触らせない＝ループを途切れさせない。
//   SAS 署名は毎回変わるため、URL 比較ではなく **id/version 比較** で同一性を判定する。
// - recoverOnError: <video> の onError（SAS 15分期限切れ等）時に、最新 SAS を張り直す再生対象を返す。
//   識別子が同一でも SAS が変わるため必ず張り直す（取得不可なら null）。

import type { Album } from "../lib/api-client";

// 現在再生中の再生対象。id/version で同一性を判定し、videoUrl（SAS URL）は毎回変わりうる。
export interface PlayingAlbum {
  id: string;
  version: number;
  videoUrl: string;
}

// 再生中アルバムの識別子（id と version）。同一性判定に使う。
export interface AlbumIdentity {
  id: string;
  version: number;
}

/**
 * 定期確認（60秒ごと）の差し替え判定。
 *
 * - 取得できなかった / 動画がまだ無い（video_sas_url 無し）→ null（現在の再生を維持。
 *   初期状態では何も表示しない）。
 * - 現在再生中と **id/version が一致** → null（同一アルバム＝src を触らずループを維持）。
 * - id か version が変化（初回の null→新規を含む）→ 新しい再生対象を返す（src 差し替え）。
 *
 * @param current 現在再生中アルバムの識別子（未再生なら null）
 * @param fetched GET /albums/latest の結果（404 等の失敗はここに来る前に null にする）
 */
export function nextOnPoll(
  current: AlbumIdentity | null,
  fetched: Album | null
): PlayingAlbum | null {
  if (!fetched || !fetched.video_sas_url) return null;
  if (
    current &&
    current.id === fetched.id &&
    current.version === fetched.version
  ) {
    return null; // 同一アルバム → src を触らない（ループ維持）
  }
  return {
    id: fetched.id,
    version: fetched.version,
    videoUrl: fetched.video_sas_url,
  };
}

/**
 * <video> の onError 時の再取得判定。
 *
 * SAS の期限切れ等で再生が止まったとき、最新 SAS で src を張り直す。識別子（id/version）が
 * 同一でも SAS URL は変わるため、動画がある限り常に新しい再生対象（新 SAS）を返す。
 * 取得できない・動画が無い場合は null（復帰できない＝そのまま）。
 *
 * @param fetched 再取得した GET /albums/latest の結果
 */
export function recoverOnError(fetched: Album | null): PlayingAlbum | null {
  if (!fetched || !fetched.video_sas_url) return null;
  return {
    id: fetched.id,
    version: fetched.version,
    videoUrl: fetched.video_sas_url,
  };
}
