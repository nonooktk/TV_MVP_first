// 委託コア③（通話後パイプライン・クライアント側）: 通話後の Blob 同期
//
// IndexedDB（modules/detection/storage.ts）に溜まった発火産物を、通話後に Blob へ
// アップロードして backend に登録する。
//
// フロー（syncCallMedia）:
//   1. IndexedDB から当該 call の photo/audio を読み出す
//   2. POST /media/upload-sas で書き込みSAS URL群を取得（data-contract.md §2）
//   3. 各 Blob を SAS URL へ PUT（x-ms-blob-type: BlockBlob）
//   4. POST /media/register（items: type photo/audio・storage_key・captured_at・metadata）
//   5. 201 確認後に該当 call の IndexedDB を削除
//   失敗はステップ単位で最大3回リトライ。最終失敗時はデータを残す（再同期に備える）。
//
// 残置分の再同期: 家族ホーム表示時に未同期 call があれば syncPendingCalls() で自動再同期する。
//
// テスト用フック window.__sync = { state }（idle/uploading/done/error と登録 memory 数）。

import { issueUploadSas, registerMedia, type MediaRegisterItem } from "../../lib/api-client";
import {
  deleteByCall,
  getAudioByCall,
  getPhotosByCall,
  listPendingCallIds,
  type AudioRecord,
  type PhotoRecord,
} from "../detection/storage";

/** 同期状態（window.__sync.state で参照）。 */
export type SyncStatus = "idle" | "uploading" | "done" | "error";

export interface SyncState {
  status: SyncStatus;
  /** 直近の同期で register した memory 数。 */
  registeredMemories: number;
  /** 最後に同期した call_id。 */
  callId: string | null;
  /** エラー時のメッセージ。 */
  error: string | null;
}

declare global {
  interface Window {
    __sync?: { state: SyncState };
  }
}

const MAX_RETRY = 3;

let syncState: SyncState = {
  status: "idle",
  registeredMemories: 0,
  callId: null,
  error: null,
};

function setState(patch: Partial<SyncState>): void {
  syncState = { ...syncState, ...patch };
  if (typeof window !== "undefined") {
    window.__sync = { state: syncState };
  }
}

// 初期化（SSR 以外で1度反映）。
if (typeof window !== "undefined") {
  window.__sync = { state: syncState };
}

/** ステップ単位のリトライ（最大3回・指数バックオフ簡易版）。 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRY) {
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
  }
  throw new Error(`${label} が ${MAX_RETRY} 回リトライしても失敗しました: ${String(lastErr)}`);
}

/** アップロード先ファイル名を type から決める（photo=candidates/*.jpg / audio=snippets/*.webm。data-contract.md §2）。 */
function filenameFor(type: "photo" | "audio"): string {
  if (type === "photo") return `candidates/${crypto.randomUUID()}.jpg`;
  return `snippets/${crypto.randomUUID()}.webm`;
}

/**
 * 指定 call の IndexedDB メディアを Blob へアップロードし backend に登録する。
 * 成功したら IndexedDB を削除する。失敗時はデータを残し例外を投げる。
 * 保存物が無い場合は何もせず done（registeredMemories=0）にする。
 */
export async function syncCallMedia(callId: string): Promise<{ registered: number }> {
  setState({ status: "uploading", callId, error: null, registeredMemories: 0 });

  try {
    const photos = await getPhotosByCall(callId);
    const audios = await getAudioByCall(callId);

    if (photos.length === 0 && audios.length === 0) {
      setState({ status: "done", registeredMemories: 0 });
      return { registered: 0 };
    }

    // アップロード対象を一覧化（type・blob・metadata・captured_at・filename）。
    type Upload = {
      type: "photo" | "audio";
      blob: Blob;
      metadata: Record<string, unknown>;
      capturedAt: string;
      filename: string;
    };
    const uploads: Upload[] = [];
    photos.forEach((p: PhotoRecord) =>
      uploads.push({
        type: "photo",
        blob: p.blob,
        metadata: p.metadata,
        capturedAt: p.capturedAt,
        filename: filenameFor("photo"),
      })
    );
    audios.forEach((a: AudioRecord) =>
      uploads.push({
        type: "audio",
        blob: a.blob,
        metadata: a.metadata,
        capturedAt: a.capturedAt,
        filename: filenameFor("audio"),
      })
    );

    // 1) upload-sas（当該通話プレフィックス限定・1時間）。
    const sas = await withRetry("upload-sas", () =>
      issueUploadSas(callId, uploads.map((u) => u.filename))
    );
    // filename → { storage_key, upload_url } の対応。
    const sasByName = new Map(sas.items.map((it) => [it.filename, it]));

    // 2) 各 Blob を PUT（ステップ単位でリトライ）。
    for (const u of uploads) {
      const item = sasByName.get(u.filename);
      if (!item) throw new Error(`SAS が返らなかった: ${u.filename}`);
      await withRetry(`PUT ${u.filename}`, async () => {
        const res = await fetch(item.upload_url, {
          method: "PUT",
          headers: {
            "x-ms-blob-type": "BlockBlob",
            "Content-Type": u.type === "photo" ? "image/jpeg" : "audio/webm",
          },
          body: u.blob,
        });
        if (!res.ok) {
          throw new Error(`Blob PUT 失敗 (${res.status}): ${u.filename}`);
        }
      });
    }

    // 3) register（items は storage_key・captured_at・metadata）。
    const items: MediaRegisterItem[] = uploads.map((u) => {
      const item = sasByName.get(u.filename)!;
      return {
        type: u.type,
        storage_key: item.storage_key,
        captured_at: u.capturedAt,
        metadata: u.metadata,
      };
    });
    const reg = await withRetry("media/register", () => registerMedia(callId, items));

    // 4) 201 相当（memory_ids を得られた）→ IndexedDB を削除。
    await deleteByCall(callId);

    setState({ status: "done", registeredMemories: reg.memory_ids.length });
    return { registered: reg.memory_ids.length };
  } catch (e) {
    // 最終失敗: データは残す（再同期に備える）。
    setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/**
 * IndexedDB に残る未同期 call をすべて再同期する（家族ホーム表示時などに呼ぶ）。
 * 1件でも同期したら true。失敗は握りつぶし、データは残す（次回に再試行）。
 */
export async function syncPendingCalls(): Promise<{ syncedCalls: number }> {
  const pending = await listPendingCallIds();
  let synced = 0;
  for (const callId of pending) {
    try {
      const { registered } = await syncCallMedia(callId);
      if (registered > 0) synced += 1;
    } catch {
      // 残置は保持（次回再試行）。
    }
  }
  return { syncedCalls: synced };
}

/** 現在の同期状態（観測用）。 */
export function getSyncState(): SyncState {
  return syncState;
}
