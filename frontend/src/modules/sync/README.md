# modules/sync

**担当: 委託コア③（通話後パイプライン・クライアント側）— M2 実装済み**

通話後、IndexedDB（`modules/detection/storage.ts`）に溜まった発火産物を Blob へ
アップロードして backend に登録するモジュール。

## API

```ts
import { syncCallMedia, syncPendingCalls, getSyncState } from "@/modules/sync";

// 通話終了時: 当該 call のメディアを同期する。
await syncCallMedia(callId);

// 家族ホーム表示時: 未同期 call をすべて再同期する（残置分の回収）。
await syncPendingCalls();
```

## `syncCallMedia(callId)` のフロー

1. IndexedDB から当該 call の photo/audio を読み出す
2. `POST /media/upload-sas` で書き込みSAS URL群を取得（当該通話プレフィックス限定・1時間）
3. 各 Blob を SAS URL へ PUT（`x-ms-blob-type: BlockBlob`）
4. `POST /media/register`（items: type photo/audio・storage_key・captured_at・metadata）
5. 201（memory_ids 取得）確認後に該当 call の IndexedDB を削除

- 失敗はステップ単位で最大3回リトライ（`withRetry`）。最終失敗時はデータを残す。
- 保存物が無い場合は何もせず `done`（registeredMemories=0）。

## 残置分の再同期

`frontend/src/app/page.tsx`（家族ホーム）が初回表示時に `syncPendingCalls()` を呼ぶ。
未同期 call があれば同期し、成功したらアルバム一覧を再取得する（「前回の思い出を
同期しています…」を控えめに表示）。

## ファイル名規約（data-contract.md §2）

- photo → `candidates/{uuid}.jpg`
- audio → `snippets/{uuid}.webm`

storage_key は upload-sas 応答の値（コンテナ名 `media` を除くフルパス）をそのまま
register に渡す。

## テスト用フック `window.__sync`

`{ state: { status, registeredMemories, callId, error } }`。
`status` は `idle` / `uploading` / `done` / `error`。
Playwright フルチェーンE2E が `state.status === "done"` と `registeredMemories` を待つ。
