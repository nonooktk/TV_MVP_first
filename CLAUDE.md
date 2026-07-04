# TV電話「元気にしてる？」MVP — プロジェクトメモリ

このリポジトリは、TV電話サービス「元気にしてる？」（仮）MVP の開発リポジトリ（モノレポ）。
LLM は本ファイルを最初に読み、確定済みの設計判断に従って作業する。

## プロダクト概要

スマホが使えない高齢者と離れて暮らす子世代をつなぐ TV 電話。
通話中に AI が「感動の瞬間」を検知して自動キャプチャし、家族が選んだベストショット5枚から
BGM 付きハイライト動画を生成、家族の閲覧 UI と高齢者側の待受画面に配信する。

コア体験: 通話 → 感情検知 → キャプチャ → 候補提示 → 家族が5枚選択 → BGM付き動画生成 → 双方で閲覧

## 確定済みの設計判断（変更には発注側の承認が必要）

- 対象ブラウザは **Chrome 最新版のみ**（両側 PC。高齢者側は役者による模擬）
- 通話は **Agora Web SDK**（1対1・channel ベース。生ストリーム到達が必須要件のため）
- 高齢者側は**待受ページ常駐**: 初回のみワンタイムリンクでデバイス登録 → 以降ポーリングで
  着信検知「でる」→ 短命トークンで入室。channel 名は通話ごとにローテーション
- 検知は**家族側ブラウザ**で実行: RMS音圧（主トリガー・EMA相対上昇＋VAD＋持続＋クールダウン）
  ＋ MediaPipe（選別指標）＋ Azure Speech STT（安全網＋ラベル）。通話中はクラウド通信なし
  （RAMリングバッファ → 発火 → 連写10枚＋音声スニペット → IndexedDB）
- 通話後パイプラインは**2段階**: 第1段=候補スコアリング・ランキング提示 →
  **家族が5枚選択（提示から5分無選択で上位5枚に自動確定。差し替えは動画再生成=version増加）** →
  第2段=Azure OpenAI（vision）ラベリング → BGM付与 → FFmpeg でハイライト動画（静止画スライドショー。
  実映像クリップは扱わない）
- 音声スニペットの用途はラベリングと写真単体閲覧時の再生。**動画の音は BGM のみ**
- インフラは **Azure 東日本で統一**（PII=顔・声のため）。Azure OpenAI は **Regional Standard 必須**
- キューは **Azure Storage Queue ＋ 常駐ワーカー**（本番で Service Bus 等へ移行可）
- Blob は非公開＋SAS のみ。DB（PostgreSQL）は台帳でありメディア実体は持たない
- Push 通知・常時フォトフレーム・不在着信・専用 Android 端末は **Release2**（MVP対象外）

## 委託と内製

- 委託コア①（通話基盤）: `frontend/src/modules/call/`＋backend トークン・着信・リンク系
- 委託コア②（検知キャプチャ）: `frontend/src/modules/detection/`
- 委託コア③（通話後パイプライン）: `frontend/src/modules/sync/`＋backend 一部＋`worker/`
- 内製: 選択UI（`select/`）・閲覧UI（`album/`、日付＋5枚一覧・タップ拡大）・認証（Entra。
  委託期間中は `lib/auth-stub.ts` の固定トークン）・DBスキーマ（`backend/app/db/`）
- 境界は API 契約・データ契約で固定（`docs/api/openapi.yaml`・`docs/data-contract.md` が正）

## リポジトリ構成

- `frontend/` Next.js（家族側＋高齢者側待受。UIシェル=支給物A8）
- `backend/` FastAPI（トークン・着信状態・メディア登録・候補・選択確定・ハイライト取得・SAS）
- `worker/` 2段階ワーカー（`stages/stage1_scoring.py`・`stage2_video.py`）。BGM=`assets/bgm/`（A12）
- `docs/` 支給物ドキュメント: `api/openapi.yaml`（A4）・`db-schema.md`（A3）・
  `data-contract.md`（A5）・`detection-params.md`（A6）・`architecture.md`・`wireframes/`
- `infra/` Azure構築メモ（A1）／`tests/` E2Eデモ台本（A9）

## 上位ドキュメント（このリポジトリ外・正本）

- RFP: `../../materials/TV電話サービス_RFP_MVP_チーム内バージョン.docx`／
  `同_コア技術外部委託バージョン.docx`（別紙にワイヤーフレーム v0.9）
- 決定事項・変遷: `../../wiki/syntheses/2026-07-02-tvphone-rfp-mvp-tech-review.md`
- アーキテクチャ・ToDo・図（シーケンス/DFD/クラス図）:
  `../../wiki/syntheses/2026-07-02-tvphone-mvp-architecture-todo.md`

## 開発ルール

- 回答・コメント・ドキュメントは日本語
- `.env` は絶対にコミットしない。`.env.example` の秘匿値は空のまま。本番秘密は Key Vault＋マネージドID
- DB スキーマは `docs/db-schema.md`（クラス図準拠）が正。変更時は md → モデル → マイグレーションの順で同期
- API は `docs/api/openapi.yaml` が正。backend ルーターとの乖離を作らない
- 検知パラメータは `docs/detection-params.md` の初期値を使う（精度チューニングは検収対象外）
- 開発期間は実働2週間。遅延時の削減優先順位は RFP 10章（①映像look-back → ②STTトリガー →
  ③visionキャプション → ④BGM → ⑤着信ポーリング → ⑥高齢者側再生 → ⑦動画生成 の順で削る）

## 現在の状態（2026-07-03）

- リポジトリ雛形（44ファイル）作成済み
- **A3 実装済み**: `backend/app/db/models.py`（SQLAlchemy 2.0・ENUM6種・インデックス6本）＋
  Alembic（`0001_initial`。オフラインDDL生成で検証済み）。実DBへの適用は A1（Azure構築）後。
  `memories.metadata` は予約属性回避のため属性名 `meta_`／DB列名 `metadata`
- **A4 実装済み**: `docs/api/openapi.yaml`（11パス・認証2系統 bearerAuth／X-Device-Token・
  スキーマ/エラー定義済み。openapi-spec-validator 通過）。Album スキーマは ready 状態の表現、
  候補提示中は CandidateList を使う
- 認証の設計: 家族=Bearer（スタブ→Entra）、高齢者待受=X-Device-Token（devices.device_token_hash
  にハッシュ保存。初回登録リンクは registration_token_hash＋registration_expires_at で管理）
- **A5 実装済み**: `docs/data-contract.md` 確定（Blobパス規約: media コンテナ・
  families/{family_id}/calls/{call_id}/ 配下・storage_key はコンテナ名抜きフルパス・
  動画は v{version}.mp4 で上書きしない／キュー: pipeline-jobs 1本・メッセージ3種
  score/auto_confirm/render・Base64 JSON／**5分自動確定は可視化遅延300秒の auto_confirm
  メッセージで実現**／冪等性・毒メッセージ・未選択候補は delete_after タグ+7日）
- **A10 実装済み**: `docs/ffmpeg-commands.md`（クロスフェード版ワンコマンド＋concat簡易版。
  机上検証のみ・実行検証は未）
- **支給物パッケージ発行済み**: `../TV_MVP_支給物/`（2026-07-03スナップショット。
  正本は本リポジトリ。乖離時は正本優先）。未準備は A1 Azure・A2 Agora・A12 BGM
- **Phase 0/1 完了（2026-07-03）**: ローカル環境（docker-compose: postgres@5433＋Azurite。
  起動手順は docs/dev-setup.md）と backend 全13エンドポイント本実装・検証済み
  （alembic実DB適用・pytest 28件全パス・Azurite実スモーク通過）。
  Agora/Speech トークンは Fake プロバイダ（アカウント取得後に差し替え）。
  実装時の契約修正: openapi に /devices/register・/media/upload-sas を追加、
  data-contract §3 render 冪等ルールを「generating のときのみ処理」に修正
- **Phase 2 完了（2026-07-03）**: worker 本実装（score=スコアリング＋無表情ゲート／
  auto_confirm=時限自動確定／render=FFmpeg クロスフェード版＋concat フォールバック・
  定型タイトル・BGM無音/ループ対応・delete_after タグ・毒メッセージ退避・--once）。
  テスト47件全パス。統合デモ（scripts/demo_pipeline.py）で手動選択・自動確定の両経路とも
  30秒 h264/aac 動画生成を ffprobe 検証。A10 の FFmpeg コマンドも実行検証済み。
  seed.py は再実行で既知デバイストークン（dev-device-token）に毎回リセットする仕様
- **Phase 4 完了（2026-07-03）**: 疑似E2Eを一巡（全7ステップ成功）し、A9
  （tests/e2e-scenario.md）を検収手順書として全面記入（RFP12章対応表・判定可否付き）。
  dev-setup.md §11 に通し手順を追記
- **アカウント不要範囲はすべて完了**。残タスク:
  - A1（Azure実環境）・A12（BGM実音源）・Azure Speech STT（削減ラダー②で除外中）・
    Azure OpenAI vision（タイトル/キャプション）
- **M2 完了（2026-07-04・検知コア②＝感情検知・自動キャプチャ＋通話後同期）**:
  - frontend `modules/detection/`: `rmsTrigger.ts`（RMS発火判定の純粋ロジック=緩いEMA
    baseline(τ=4s)からの相対上昇＋VADゲート＋持続200ms＋クールダウン4s。支給初期値。
    チューニングは検収対象外）／`audioPipeline.ts`（WebAudio で rms_dB 50ms間隔＋
    MediaRecorder timeslice=1s リング保持→発火時に先頭ヘッダ＋発火前2秒〜後3秒を結合した
    webm スニペット。**チャンク結合の割り切り**をコメント明記）／`facePipeline.ts`
    （`@mediapipe/tasks-vision` FaceLandmarker で face_score。ロード失敗時は 0 で継続）／
    `videoRing.ts`（映像look-back 直近3コマ）／`burst.ts`（連写10枚＋look-back前置）／
    `storage.ts`（IndexedDB=`idb`。call_id別 photos/audio）／`sttProvider.ts`
    （インターフェース＋noopのみ＝**削減ラダー②適用**）／`index.ts`（`attachDetection`＋
    テスト用 `window.__detection.{forceTrigger(),state}`）。metadata は data-contract 付録キー
    （rms_db/rms_rise/face_score/trigger_reason/lookback）＋captured_at
  - frontend `modules/sync/`: `syncCallMedia(callId)`（IndexedDB→upload-sas→Blob PUT→
    register→受領確認後に削除。ステップ単位で最大3回リトライ・最終失敗はデータ残置）／
    `syncPendingCalls()`（家族ホームで残置分を自動再同期）／`window.__sync.state`
  - 家族 `/call` 統合: uid=2 の video/audio 到着で `attachDetection` 接続、「● AI記録中」
    バッジを実状態に（発火時フラッシュ＋記録カウント）、通話終了で「思い出を準備中…」→
    `syncCallMedia`→候補ポーリング→`/select` 自動遷移（記録0件はホームへ）。検知は
    best-effort（許可拒否・MediaPipe失敗でも通話継続）
  - MediaPipe アセット: **`frontend/public/mediapipe/`（WASM＋モデル.task）にコピーして
    ローカル配信**（CDN依存回避。手順は `modules/detection/README.md`）。初回ロードは
    warm で約350ms・cold で約1〜2秒（XNNPACK delegate 込み）
  - backend: **CORS 対応のみ追加**（`BlobService.set_cors()` ＋ `scripts/set_blob_cors.py`）。
    ブラウザ直 Blob PUT に必須（本番=Azure は A1 の storage-account CORS が担当。
    ローカル=Azurite はスクリプトで設定）。worker/pipeline ロジックは無変更
  - 検証: vitest 6件（rmsTrigger）・Playwright M1（call.spec.ts）・M2 フルチェーン
    （detection-chain.spec.ts: 通話→forceTrigger→IndexedDB photos13(連写10+look-back3)/
    audio1→同期 registered14→score→candidates13→5枚選択→render→album ready v1）・
    pytest 61件、すべてパス（dev-setup.md §12）
  - 注意: `next dev` 稼働中に `next build` を実行しない（.next 共有で dev サーバが壊れる）
- **M1 完了（2026-07-04・Agora実通話接続）**:
  - backend: `RealAgoraTokenProvider`（agora-token-builder・role=publisher・TTL 3600秒
    =MVP初期値）を追加し、settings の AGORA_APP_ID / AGORA_APP_CERTIFICATE が両方
    非空なら Real、欠けたら Fake に DI で自動切替（デモ環境を壊さない）。
    uid ルールを固定（家族=1・高齢者=2。M2 で uid=2 に検知を接続する布石）
  - 契約変更（openapi.yaml v0.3.0・validator 通過）: ①トークン応答
    （/tokens/call・answer）に `app_id`（公開値）を追加 ② `POST /calls/{call_id}/end`
    新設（家族 Bearer・デバイス X-Device-Token の両認証・冪等）＝**既知課題#1 を解消**
    ③ GET /calls/incoming は「calling かつ作成から120秒以内」のみ着信として返す（失効）
  - frontend: `modules/call/agoraCall.ts`（通話モジュール本体。dynamic import で SSR回避・
    Strict Mode 対策の join/leave 直列化・テスト用 `window.__callState` フック内蔵）。
    家族 `/call` は相手大＋自分小窓・許可拒否時の再開画面（WF-02）、高齢者 standby は
    「でる」で入室・相手全画面・「きる」控えめ（WF-01③④）。相手が切ると双方自動復帰
  - 検証: pytest 61件全パス（既存47＋新規14: end 両認証/冪等・incoming 失効・
    プロバイダ切替〈実証明書は不使用〉）。Playwright 自動通話テスト
    （frontend/tests-e2e/・dev-setup.md §12）で両側 `remoteVideo=true` を実 Agora 接続で
    確認（発信〜相互受信 約3.4〜3.8秒）。証明書のコード・リポジトリ非混入を grep 確認
  - 注意: `next dev` 稼働中に `next build` を実行しない（.next 共有で dev サーバが壊れる。
    dev-setup.md §12 に記載）
- **既知課題（Phase 4 で記録）**:
  1. ~~通話を ended にする明示APIが無い~~ → **M1 で解消**（POST /calls/{call_id}/end ＋
     incoming の120秒失効）
  2. ready 後の /select 再確定に「確定済み」表示が無い（意図せぬ再生成を誘発しうる）
  3. ホームの「さいきんのハイライト」カードに個別アルバムへのリンクが無い
  4. demo のダミー画像は番号なし単色（.venv に Pillow 追加で改善可）
  5. 家族側デバイス一覧APIなし／GET /albums に写真なし（Phase 3 の制約と同じ）
- **Phase 3 完了（2026-07-03）**: frontend 内製UI本実装（`frontend/src/app/` 全6ページ
  ＋`lib/api-client.ts`・`lib/auth-stub.ts` 連携・`globals.css`）。
  backend は `app/main.py` に CORS（`allow_origins=["http://localhost:3000"]`）のみ追加。
  `next build` 成功・実backend（docker compose＋uvicorn＋seed済み）で
  elder register→standby ポーリング／select 候補表示／album 一覧・動画再生を
  ブラウザ実疎通確認済み（詳細は次項の制約・注意点を参照）。
  - 制約: 家族側にデバイス一覧APIが無い（1家族1デバイス固定設計）ため、
    発信ボタンの device_id は `frontend/.env.local` の
    `NEXT_PUBLIC_DEFAULT_DEVICE_ID`（seed.py 出力値）を暫定使用。
    複数デバイス対応時は backend にデバイス一覧APIの追加が必要。
  - 制約: `GET /albums` は写真一覧を返さないため、album ページは
    `selected_memory_ids` を `GET /calls/{call_id}/candidates` の結果と
    突合して sas_url を得ている（N+1・既存API内で実現）。
  - 環境固有の既知事象: このマシンの Next.js 14.2.0 + TypeScript 6.0.3 の組み合わせで
    tsconfig の `baseUrl` が非推奨エラーになったため削除。CSS の side-effect import
    型解決も効かなかったため `frontend/src/css.d.ts`（`declare module "*.css"`）を追加。
