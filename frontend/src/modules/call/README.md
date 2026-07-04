# modules/call

**担当: 委託コア①（通話基盤）— M1 で実装済み**

Agora Web SDK による通話接続モジュール。本体は `agoraCall.ts`。

## 提供機能（agoraCall.ts）

- `startCall(opts)`: createClient → join(app_id, channel, token, uid) →
  ローカルカメラ/マイクの publish → リモートの subscribe/再生 までを実行し、
  `CallHandle`（`leave()`）を返す
- remote-user の published / left はコールバック（`onRemoteVideo` / `onRemoteLeft`）で通知
- `isPermissionDenied(err)`: カメラ/マイク許可拒否の判定（WF-02 例外画面の分岐用）
- uid ルール定数: `UID_FAMILY = 1`・`UID_ELDER = 2`（backend の `app/services/agora.py` と一致）
- テスト用フック: `window.__callState`（`joined` / `remoteVideo`）を更新する
  （`frontend/tests-e2e/` の Playwright 自動通話テストが参照）

## 利用箇所

- 家族側 `src/app/call/page.tsx`（`POST /tokens/call` → join、uid=1）
- 高齢者側 `src/app/elder/standby/page.tsx`（`POST /calls/{id}/answer` → join、uid=2）

## M2（検知コア②）への差し込み口

`onRemoteMediaStreamTrack(kind, track, uid)` でリモートの生 MediaStreamTrack を受け渡す。
検知（RMS音圧＋MediaPipe＋STT）は **uid=2（高齢者）のストリーム**に接続する。

## 注意

- SDK はブラウザ専用のため dynamic import で読み込む（SSR 回避）。ページ側は
  useEffect 内から `startCall` を呼ぶこと
- React Strict Mode（dev）の effect 二重実行対策として、直前の leave 完了を
  待ってから join する直列化を内蔵している
