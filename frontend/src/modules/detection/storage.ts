// 委託コア②（検知キャプチャ）: IndexedDB 保存層
//
// 発火ごとに、連写写真（Blob + metadata）と音声スニペット（Blob）を call_id 別に保存する。
// 通話後に modules/sync/ がこれを読み出して Blob へアップロードし、登録後に削除する。
//
// 依存は `idb`（薄いラッパ）まで。ストア構成:
//   - photos: { id(auto), callId, blob, metadata, capturedAt(ISO), lookback }
//   - audio:  { id(auto), callId, blob, metadata, capturedAt(ISO) }
//   - meta_index はインデックス callId で引く。

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

/** data-contract.md 付録の metadata 推奨キー（rms_db/rms_rise/face_score/trigger_reason/lookback）。 */
export interface CaptureMetadata {
  rms_db?: number;
  rms_rise?: number;
  face_score?: number;
  trigger_reason?: "rms" | "stt" | "face" | "centroid";
  lookback?: boolean;
  blendshapes_top?: string[];
  /** 発火時のスペクトル重心（Hz・改良2）。data-contract.md 付録キー。 */
  spectral_centroid?: number;
  /** 発火時の重心の基準比（現在値 / 基準・改良2）。data-contract.md 付録キー。 */
  centroid_rise_ratio?: number;
  /**
   * 発火元（声トリガーの両側化・2026-07-10 追加）。
   * "elder"=高齢者側リモート音声（既存の唯一の系統）／"family"=家族側ローカルマイク（第2系統）。
   * 省略時（過去データ）は elder 扱い。data-contract.md 付録キー。
   */
  trigger_source?: "elder" | "family";
  /**
   * 写真の取得元カメラ（両側連写・Phase 2 追加）。
   * "elder"=高齢者側リモート映像／"family"=家族側ローカルカメラ（孫が映る側）。
   * 発火のたびに両ストリームから連写するため、1発火で elder / family 両方の写真が生成される。
   * 省略時（過去データ）は elder 扱い。data-contract.md 付録キー。
   * 音声スニペットには付与しない（音声は高齢者側のみ）。
   */
  stream?: "elder" | "family";
  [key: string]: unknown;
}

/** 保存する写真レコード。 */
export interface PhotoRecord {
  id?: number;
  callId: string;
  blob: Blob;
  metadata: CaptureMetadata;
  /** 撮影時刻（ISO 8601 UTC）。media/register の captured_at に使う。 */
  capturedAt: string;
}

/** 保存する音声スニペットレコード。 */
export interface AudioRecord {
  id?: number;
  callId: string;
  blob: Blob;
  metadata: CaptureMetadata;
  capturedAt: string;
}

interface DetectionDB extends DBSchema {
  photos: {
    key: number;
    value: PhotoRecord;
    indexes: { byCall: string };
  };
  audio: {
    key: number;
    value: AudioRecord;
    indexes: { byCall: string };
  };
}

const DB_NAME = "tvmvp-detection";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<DetectionDB>> | null = null;

function getDb(): Promise<IDBPDatabase<DetectionDB>> {
  if (!dbPromise) {
    dbPromise = openDB<DetectionDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const photos = db.createObjectStore("photos", {
          keyPath: "id",
          autoIncrement: true,
        });
        photos.createIndex("byCall", "callId");
        const audio = db.createObjectStore("audio", {
          keyPath: "id",
          autoIncrement: true,
        });
        audio.createIndex("byCall", "callId");
      },
    });
  }
  return dbPromise;
}

/** 1発火ぶんの写真群を保存する（連写＋look-back）。 */
export async function savePhotos(
  records: Omit<PhotoRecord, "id">[]
): Promise<number[]> {
  const db = await getDb();
  const tx = db.transaction("photos", "readwrite");
  const ids: number[] = [];
  for (const rec of records) {
    const id = await tx.store.add(rec as PhotoRecord);
    ids.push(id as number);
  }
  await tx.done;
  return ids;
}

/** 音声スニペットを1件保存する。 */
export async function saveAudio(record: Omit<AudioRecord, "id">): Promise<number> {
  const db = await getDb();
  const id = await db.add("audio", record as AudioRecord);
  return id as number;
}

/** 指定 call の写真を全件取得する。 */
export async function getPhotosByCall(callId: string): Promise<PhotoRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex("photos", "byCall", callId);
}

/** 指定 call の音声を全件取得する。 */
export async function getAudioByCall(callId: string): Promise<AudioRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex("audio", "byCall", callId);
}

/** 指定 call の件数（photo / audio）。テスト・観測用。 */
export async function countByCall(
  callId: string
): Promise<{ photos: number; audio: number }> {
  const db = await getDb();
  const photos = await db.countFromIndex("photos", "byCall", callId);
  const audio = await db.countFromIndex("audio", "byCall", callId);
  return { photos, audio };
}

/** 未同期の call_id 一覧（photos か audio に1件でも残っているもの）。 */
export async function listPendingCallIds(): Promise<string[]> {
  const db = await getDb();
  const ids = new Set<string>();
  for (const rec of await db.getAll("photos")) ids.add(rec.callId);
  for (const rec of await db.getAll("audio")) ids.add(rec.callId);
  return [...ids];
}

/** 指定 call のレコード（photo / audio 両方）を削除する。同期完了後に呼ぶ。 */
export async function deleteByCall(callId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["photos", "audio"], "readwrite");
  for (const store of ["photos", "audio"] as const) {
    const idx = tx.objectStore(store).index("byCall");
    let cursor = await idx.openCursor(IDBKeyRange.only(callId));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }
  await tx.done;
}
