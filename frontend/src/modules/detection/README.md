# modules/detection

**担当: 委託コア②（検知キャプチャ）— M2 実装済み**

通話中の相手（高齢者・uid=2）ストリームから感情の瞬間を検知し、連写＋音声スニペットを
ローカル（IndexedDB）へキャプチャするモジュール。パラメータは `docs/detection-params.md` 準拠。

## 構成

| ファイル | 責務 |
| --- | --- |
| `rmsTrigger.ts` | 発火判定の純粋ロジック（クラス）。baseline=緩いEMA(τ=4s)からの相対上昇＋VADゲート＋持続200ms＋クールダウン4s。パラメータは `DEFAULT_RMS_PARAMS` に集約（支給初期値・チューニングは検収対象外） |
| `audioPipeline.ts` | WebAudio AnalyserNode で rms_dB を約50ms間隔で算出→RmsTrigger へ。並行して MediaRecorder(timeslice=1s)でチャンクをリング保持し、発火時に「先頭チャンク＋発火前2秒〜後3秒」を結合して webm スニペットを構成 |
| `facePipeline.ts` | `@mediapipe/tasks-vision` FaceLandmarker で face_score（mouthSmile系blendshape中心の0〜1）を約200ms間隔で算出。**WASM/モデルは CDN 優先＋ローカル fallback でロード**（本番 SWA の大容量アセット throttle 回避・下節参照）。ロード失敗時は face_score=0 で継続。起動タイムアウト（10s）で `health` を必ず終端（loading で固まらない）し、停止理由を `health().reason` で公開 |
| `videoRing.ts` | 相手映像を200ms間隔で低解像度canvasに保持（直近3コマ・JPEG）＝映像look-back |
| `burst.ts` | 発火時に連写10枚（約2秒・200ms間隔・通話解像度）＋look-backコマを収集 |
| `storage.ts` | IndexedDB 保存（call_id別。photo=Blob+metadata、audio=Blob）。依存は `idb` |
| `sttProvider.ts` | STT インターフェース＋noopスタブ（`NoopSttProvider`。テストで STT を完全無効化したいとき用） |
| `sttConfig.ts` | 感情ワード辞書（`EMOTION_WORDS`）＋STT設定（言語/更新間隔/16kHz）＋純粋関数（`matchEmotionWords`・`passesSharedCooldown`・`downsampleToPcm16` は azureStt に定義） |
| `azureSttProvider.ts` | **Azure Speech STT（削減ラダー②解除）**。リモート音声→WebAudioでPCM16・16kHz化→`PushAudioInputStream`→ja-JP連続認識。フレーズリストで感情ワードを強化。トークンは `/tokens/speech` から約9分ごと更新。best-effort（SDK/トークン失敗はSTT無効のまま継続） |
| `index.ts` | `attachDetection({ stream, callId, onEvent, stt? })` で全配線。既定で `AzureSttProvider` を使い、感情ワードヒットで `reason="stt"` 発火（RMSと共有クールダウン4秒）。テスト用フック `window.__detection`（`state.stt` 追加）を内蔵 |

## 使い方

```ts
import { attachDetection } from "@/modules/detection";

// uid=2 の高齢者ストリーム（video/audio）を MediaStream にまとめて渡す。
const handle = attachDetection({
  stream,               // MediaStream（少なくとも audio トラックが必要）
  callId,               // 通話ID（IndexedDB の保存キー）
  onEvent: (ev) => {    // 発火のたびに呼ばれる（バッジのフラッシュ・カウント表示）
    console.log("記録:", ev.photoCount, "枚 / audio:", ev.hasAudio);
  },
});
// 通話終了時
handle.detach();
```

`frontend/src/app/call/page.tsx` が `agoraCall.ts` の `onRemoteMediaStreamTrack`
（uid=UID_ELDER=2）から video/audio トラックを集め、音声が揃った時点で `attachDetection` する。

## metadata（data-contract.md 付録キー）

各キャプチャに以下を付ける（IndexedDB → sync → `POST /media/register` の metadata へ）。

- `rms_db` / `rms_rise` … 発火時の音圧・baseline比上昇量
- `face_score` … 発火時の表情スコア（0〜1）
- `blendshapes_top` … 上位blendshape名（あれば）
- `trigger_reason` … `rms`（音圧）または `stt`（感情ワード・削減ラダー②解除で追加）
- `stt_text` / `stt_labels` … STT 有効時のみ。直近約10秒の認識テキストと感情ワードヒット
- `lookback` … look-back（発火前バッファ由来）コマか否か
- `captured_at` … 撮影時刻（ISO 8601 UTC）

## MediaPipe アセットの配信（CDN優先＋ローカル fallback）

> **2026-07-05 変更**: 当初はローカル配信のみ（CDN依存回避）だったが、本番
> （Azure Static Web Apps Free）が **9.4MB の WASM・3.7MB のモデルといった大容量静的
> アセットの配信を ~40〜70KB/s に強く throttle** し、起動タイムアウト（10s）内に
> ダウンロードできず「⚠️ 表情検知が停止中」になった（dev はディスク即時配信のため成功＝
> 本番ビルドでのみ再現）。実測: 同一 9.4MB WASM が SWA では 30s で 1〜2MB しか届かず停止
> する一方、jsDelivr CDN では 1.16s（約8MB/s）で完走する（byte-identical・version pin 済み）。
> → **`facePipeline.ts` は CDN 優先＋ローカル fallback** に変更した。
> - WASM:  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@<pin>/wasm`（1次）→ `/mediapipe/wasm`（fallback）
> - モデル: Google Storage（float16 公開モデル）（1次）→ `/mediapipe/models/face_landmarker.task`（fallback）
> - `TASKS_VISION_VERSION` は `package.json` の `@mediapipe/tasks-vision` 版と一致させること。
> - 表情検知モデルは Google 公開の非PIIファイル。**通話中の顔・音声データは従来どおり
>   クラウドへ出さない**（CDN 依存は表情検知アセットの取得に限る＝PII 境界は不変）。
> - ロード成功元は `window.__detection.state.face.source`（`"cdn"|"local"`）で観測できる。

ローカル配信（fallback）用に WASM とモデル（.task）は `frontend/public/mediapipe/` へ
コピーして置く（オフライン・CDN 障害時の保険）。

**コピー手順（再取得時）:**

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/frontend

# 1) npm パッケージを導入（初回のみ）
npm install @mediapipe/tasks-vision idb

# 2) WASM を public へコピー（node_modules 内アセット）
mkdir -p public/mediapipe/wasm public/mediapipe/models
cp node_modules/@mediapipe/tasks-vision/wasm/* public/mediapipe/wasm/

# 3) FaceLandmarker モデル（float16）を取得
curl -sL -o public/mediapipe/models/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
```

`public/mediapipe/` はビルド成果物であり、必要に応じて `.gitignore` 対象にしてもよい
（本手順で再生成できる。合計 約22MB: WASM 約19MB＋モデル 約3.7MB）。

## テスト用フック `window.__detection`

- `forceTrigger(): Promise<void>` … 実発火と同じ経路（`handleTrigger`）で1回発火させる。
  連写＋音声スニペット構成＋IndexedDB 保存まで実発火と同一。
- `state` … 内部状態スナップショット（`triggerCount` / `lastFaceScore` /
  `face.{loaded,failed}` / `audio.{hasHeader,ringChunks,mimeType}` / `rms.{baselineDb,...}`）。

Playwright フルチェーンE2E（`frontend/tests-e2e/detection-chain.spec.ts`）が `forceTrigger()`
を使い、IndexedDB に photo 10件＋audio 1件が保存されることを assert する。

## 割り切り（MVP）

- **音声チャンク結合**: webm/opus のチャンクは MediaRecorder のタイムスライス境界で切られる。
  先頭チャンク（コンテナヘッダを含む）を常時保持し、区間チャンクの前に素朴に Blob 結合する。
  厳密には各チャンクは独立デコード可能ではないが、Chrome では概ね再生可能な webm になる
  （用途はラベリングと写真単体閲覧時の再生。詳細は `audioPipeline.ts` 冒頭コメント）。
- **STT（削減ラダー②解除・2026-07-05）**: Azure Speech で感情ワードを検知し `reason="stt"` で発火する
  （`azureSttProvider.ts`・辞書は `sttConfig.ts`）。Speech キー未設定（Fake トークン）や SDK/トークン
  失敗では STT 無効のまま通話・RMS検知を継続する（best-effort）。ローカル有効化は dev-setup §13-7。
- **検知は best-effort**: カメラ許可拒否・MediaPipe ロード失敗・STT 失敗等でも通話は継続する。
