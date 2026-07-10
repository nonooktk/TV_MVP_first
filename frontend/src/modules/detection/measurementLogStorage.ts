// 委託コア②（検知キャプチャ）: 計測ログの永続化層（通話終了後の回収導線）
//
// 目的: 実地テストで「通話中にDLし忘れた」「タブをクラッシュ／通話画面を閉じてしまった」
// ケースでも、後からホーム画面で計測ログを回収できるようにする。
//
// 設計判断（upsert＝完全スナップショット置き換え。差分追記ではない）:
//   計測ログの保存は「その時点の MeasurementLog.toExport() の完全スナップショットで、
//   当該 call_id のレコードを丸ごと置き換える」方式にする。
//   - 通話中は約10秒ごとに自動フラッシュ（index.ts の setInterval から呼ぶ）。
//   - 通話終了時にもう一度確定フラッシュを行う（detach() 内）。
//   この2種のフラッシュは呼ばれる回数も順序も呼び出し側の都合で前後し得るが、いずれも
//   「呼ばれた時点の toExport() 全体」を put（同一 keyPath=callId のレコードを上書き）する
//   ため、複数回フラッシュされても最後に反映されたものが常に最新の完全な状態になる
//   （差分マージではないので、順序に依存した欠落・重複が原理的に起きない）。
//   例: 10秒フラッシュ（samples=10件）→ 通話終了確定フラッシュ（samples=15件）の順で
//   呼んでも、後勝ちで15件のレコードが残る。万一逆順で呼ばれても同様に「呼ばれた時点で
//   最も内容が新しい方」が最終的に残る（MeasurementLog 自体が単調増加のリングバッファで
//   あるため、後から呼ばれた toExport() のほうが常に同じかそれ以上の情報を持つ）。
//
// 保存上限: 直近 MAX_STORED_CALLS 件（call_id ごとに1レコード）。上限を超えたら
// updatedAt が最も古いレコードから削除する（LRU 的だが「最後にフラッシュされた時刻」基準）。
//
// フラッシュ・保存は best-effort。失敗しても検知・通話を止めない
// （呼び出し側 index.ts で try/catch + console.warn する。本モジュール自身も
// IndexedDB 未対応環境（SSR 等）で例外を投げないよう getDb() 呼び出し側で吸収する）。
//
// 既存 storage.ts（tvmvp-detection・photos/audio）とは別ファイル・別DBにする
// （既存 DetectionDB の実装・DB_VERSION には一切触れない方針のため）。

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { MeasurementLogExport } from "./measurementLog";

/** 保存する call ごとのレコード。 */
export interface StoredMeasurementLog {
  /** 通話ID（keyPath）。 */
  callId: string;
  /** 直近のフラッシュ時刻（ISO 8601）。ローテーション判定・一覧の並び替えに使う。 */
  updatedAt: string;
  /** その時点の計測ログ全体（完全スナップショット）。 */
  data: MeasurementLogExport;
}

/** ホーム画面の一覧表示用の軽量サマリ（data 本体を含まない）。 */
export interface MeasurementLogSummary {
  callId: string;
  updatedAt: string;
  samples: number;
  events: number;
}

interface MeasurementLogDB extends DBSchema {
  logs: {
    key: string; // callId
    value: StoredMeasurementLog;
    indexes: { byUpdatedAt: string };
  };
}

const DB_NAME = "tvmvp-measurement-log";
const DB_VERSION = 1;

/** 保存上限（call_id ごとに1レコード）。超えたら updatedAt が最古のものから削除する。 */
export const MAX_STORED_CALLS = 10;

let dbPromise: Promise<IDBPDatabase<MeasurementLogDB>> | null = null;

function getDb(): Promise<IDBPDatabase<MeasurementLogDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MeasurementLogDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const logs = db.createObjectStore("logs", { keyPath: "callId" });
        logs.createIndex("byUpdatedAt", "updatedAt");
      },
    });
  }
  return dbPromise;
}

/**
 * 計測ログを1件 upsert（完全スナップショット置き換え）する。
 * 保存後、件数が MAX_STORED_CALLS を超えていたら updatedAt が最も古いレコードから削除する。
 *
 * best-effort ではない（呼び出し側で try/catch すること。本関数自体は例外を透過する）。
 */
export async function flushMeasurementLog(
  data: MeasurementLogExport,
  nowMs = Date.now()
): Promise<void> {
  const db = await getDb();
  const record: StoredMeasurementLog = {
    callId: data.call_id,
    updatedAt: new Date(nowMs).toISOString(),
    data,
  };
  await db.put("logs", record);
  await rotateIfNeeded(db);
}

/** MAX_STORED_CALLS を超えていたら updatedAt 昇順（最古から）で溢れた分を削除する。 */
async function rotateIfNeeded(db: IDBPDatabase<MeasurementLogDB>): Promise<void> {
  const all = await db.getAllFromIndex("logs", "byUpdatedAt");
  const overflow = all.length - MAX_STORED_CALLS;
  if (overflow <= 0) return;
  // byUpdatedAt 昇順（古い順）の先頭 overflow 件を削除する。
  const tx = db.transaction("logs", "readwrite");
  for (let i = 0; i < overflow; i++) {
    await tx.store.delete(all[i].callId);
  }
  await tx.done;
}

/**
 * 保存済み計測ログの一覧をサマリ形式で返す（日時降順＝新しい順）。
 * ホーム画面の「計測ログ（トリガーテスト用）」セクション用。
 */
export async function listMeasurementLogs(): Promise<MeasurementLogSummary[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex("logs", "byUpdatedAt");
  return all
    .map((r) => ({
      callId: r.callId,
      updatedAt: r.updatedAt,
      samples: r.data.samples.length,
      events: r.data.events.length,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 指定 call_id の計測ログ全体（ダウンロード用）を取得する。無ければ null。 */
export async function getMeasurementLog(
  callId: string
): Promise<StoredMeasurementLog | null> {
  const db = await getDb();
  const rec = await db.get("logs", callId);
  return rec ?? null;
}

/** 指定 call_id の計測ログを削除する（ホーム画面の削除ボタン用）。 */
export async function deleteMeasurementLog(callId: string): Promise<void> {
  const db = await getDb();
  await db.delete("logs", callId);
}
