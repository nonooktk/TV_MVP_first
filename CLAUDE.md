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

## 確定済み設計からの乖離（暫定運用）

- **タイトル/キャプション生成の直 OpenAI API 利用（2026-07-04〜）**:
  MVP 期間中の暫定として、タイトル生成は支給 OpenAI キー（直 API・`OpenAILabelProvider`）を
  優先利用する。顔画像が Azure 境界外（OpenAI）に出るため、**本番前に Azure OpenAI Regional
  （構築済み `oai-tvmvp-73bb`）へ戻す**（worker の環境変数を `LABEL_PROVIDER=azure` に
  切り替えるだけ。選択ロジックは `worker/stages/labels.py` の `get_label_provider` 参照）。
  被験者がチーム内役者のため許容（発注側承認 2026-07-04）。

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

## 現在の状態（2026-07-05）

- **ユーザーフィードバック改善 第2段（frontend＋クラウド反映＋計測）完了（2026-07-05）**:
  - **frontend（新 GET /albums へ全面移行）**:
    - 共通コンポーネント `components/ThumbImage.tsx`（thumb_sas_url 優先・onError で
      sas_url へ自動フォールバック・`loading="lazy"` 既定）と `components/BackHeader.tsx`
      （「← ホームへ」。album / select に設置）を新設。
    - `album/page.tsx` 全面書き換え: **candidates 突合の N+1 コードを削除**し `photos` を
      直接使用（アルバム一覧の API 呼び出しは `/albums` 1回のみ）。状態別カード
      （awaiting_selection=選択待ち＋選択ページボタン／generating=スピナー＋
      「作成中…（目安30秒〜1分）」・**5秒間隔ポーリングで ready へ自動切替**／
      ready=「動画｜コラージュ」タブ〈collage_sas_url null 時はタブ非表示〉＋5枚サムネ
      スタック〈拡大は原寸〉＋**削除ボタン**〈指定文言の確認ダイアログ→DELETE→一覧から除去〉）。
      `?highlight=<album_id>` で該当カードへスクロール＋一時ハイライト。
    - `select/page.tsx`: 候補グリッドを thumb_sas_url 表示（フォールバック付き）に変更。
      確定後の遷移先を `/album?highlight=<album_id>`（生成中カードが見える）に変更。
    - 家族ホーム: ハイライトカードに `/album?highlight=<id>` への遷移を付与
      （**既知課題#3 解消**）。generating があれば「思い出を作成中…」バナー。
      一覧が全状態を返すようになったため、ハイライト/新着バナーは ready のみで判定。
    - 高齢者待受: 変更なし（backend `/albums/latest` は ready のみ返す実装を確認・崩れなし）。
    - `api-client.ts`: `AlbumPhoto` 型・`Album.collage_sas_url/photos`・
      `Candidate.thumb_sas_url`・`deleteAlbum()`・`getAlbums(status)` を追加。
  - **クラウド反映（順序: DB→worker→api→SWA）**: クラウドDBへ alembic 0002 適用
    （0001→0002・`alembic current`=0002 確認）。worker **v3**（Pillow入り）→
    `ca-tvmvp-worker` rev 0000007。api **v3** → `ca-tvmvp-api` rev 0000006・/healthz 200。
    frontend をクラウドURL埋め込みで再ビルド→SWA デプロイ（チャンクハッシュ一致確認）。
    クラウド GET /albums が新形式（status/photos5枚/collage_sas_url）で返ること・既存 ready
    3件が photos 付きで返ることを確認（過去データは thumbs 未生成→フォールバック=仕様どおり）。
  - **クラウド実地検証（API直叩きデモ通話）**: upload→register→worker v3 が thumbs
    5/5 生成→selection→render で**コラージュ生成（約264KB）**→ready→**DELETE 204・
    一覧から消失**まで一巡（検証データは削除済み）。
  - **軽量化の計測**:
    - 転送量（クラウド新規デモ通話・1280x720 ダミーJPEG）: 原寸5枚合計 **1,779,577 bytes**
      → サムネ5枚合計 **26,186 bytes**（**削減率 98.5%**）。
      参考（ローカル・detection-chain の実キャプチャ640x480）: 46,640 → 18,112 bytes（61.2%。
      原寸が小さいほど削減率は下がる）。クラウド既存 ready アルバム（過去データ・thumbs
      未生成）の原寸5枚合計は 211,885 bytes（旧方式相当の実測値）。
    - API 呼び出し数（アルバム一覧表示）: 旧 **1+N**（N=アルバム件数。20件なら21回）→
      新 **1回**。実ブラウザで `/albums` 1回・`/calls/{id}/candidates` 0回を確認。
  - 検証: pytest 104件・vitest 18件・`next build` 成功・**Playwright 2本**
    （call.spec.ts / detection-chain.spec.ts）パス（UI変更によるセレクタ修正は不要だった）。
    ローカル実ブラウザでタブ切替・削除フロー（ダイアログ文言・204・一覧除去）・
    フォールバック表示・選択待ちカードを目視確認。
  - ドキュメント: tests/e2e-scenario.md ステップ7 を更新（状態別カード・コラージュ・削除）。
    `.claude/launch.json`（frontend-dev プレビュー設定）を追加。

- **ユーザーフィードバック改善 第1段（backend＋worker＋契約・マイグレーション）
  完了（2026-07-05・openapi v0.5.0）**:
  - **サムネイル生成（軽量化の本命）**: worker 第1段（stage1_scoring）が各写真候補の
    サムネ（**幅320px・JPEG品質70**・Pillow）を生成し `.../thumbs/{memory_id}.jpg` へ
    アップロード（`worker/stages/images.py`）。生成失敗は警告ログでスキップ（候補処理は
    止めない）。Pillow を worker/requirements.txt と worker/Dockerfile（backend/requirements.txt
    経由でないため pip 行に明示追加）へ導入。
  - **GET /albums 拡張（N+1解消＋進捗可視化）**: `status` クエリ（省略時 all＝
    awaiting_selection / generating / ready をすべて返す。**従来は ready のみ＝互換断絶。
    フロント対応は第2段**）。各要素に `status`・`presented_at`・`collage_sas_url`（ready かつ
    存在時）・`photos`（確定5枚。awaiting_selection では空配列。`{memory_id, thumb_sas_url,
    sas_url, captured_at}`）を追加。確定5枚の memory を一括取得して N+1 を解消。
    GET /calls/{call_id}/candidates の各候補にも `thumb_sas_url` を追加。SAS はパス規約から
    導出して発行し存在チェックはしない（フロントは thumb 未生成時 sas_url にフォールバック）。
  - **DELETE /albums/{album_id} 新設（完全削除）**: 家族 Bearer かつ **role=owner のみ**
    （viewer は 403）。削除対象は ①album 行 ②動画 Blob 全版（albums/v*.mp4）③コラージュ Blob
    ④確定5枚の memories 行とその Blob（candidates/・thumbs/）。音声スニペット・call 行は残す。
    Blob 削除は存在しないものをスキップ（冪等）。応答 204。アプリ機能としてのデータ削除で
    Azureリソース削除ではない（`BlobService.delete_blob`/`delete_prefix` を追加）。
  - **コラージュ生成（スキーマ変更を含む）**: db-schema.md → models.py → **マイグレーション
    0002_album_collage**（albums に `collage_storage_key` nullable 追加。オフライン --sql 確認後
    ローカル実DBへ適用済み・head=0002）。worker 第2段（render）が確定5枚から**1枚のコラージュ
    JPEG**（横1600px・2行グリッド〈上段2枚・下段3枚〉・白余白・各セルはアスペクト維持クロップ）
    を生成し `.../albums/collage_v{version}.jpg` へ保存、`collage_storage_key` を更新。生成失敗は
    警告ログのみ（動画は成立）。
  - 検証: **pytest 104件全パス**（91＋新規13: /albums の status・photos・collage／DELETE の
    owner204・viewer403・Blob削除・冪等／candidates の thumb_sas_url／worker のサムネ生成・
    失敗スキップ・コラージュ生成・失敗時null）。openapi v0.5.0 を validator 通過。マイグレーション
    0002 適用済み。**ローカル通し確認**（demo_pipeline＋worker --once・実Azurite）で thumbs 6枚生成・
    /albums が photos5＋status＝ready＋collage_sas_url を返す・コラージュ Blob 約42KB 実在・
    DELETE で album 行＋確定5 memory 行＋動画/コラージュ Blob が消えることを観測。
  - **既知課題（GET /albums に写真なし＝N+1）解消**。frontend 対応とクラウド反映は
    **第2段で完了**（上記 2026-07-05 の項を参照）。

- **既知課題#5（device_id 焼き込み）解消（2026-07-05・openapi v0.4.0）**:
  - 事象: クラウドで発信時「デバイスが見つかりません」。フロントの発信が build 時埋め込みの
    `NEXT_PUBLIC_DEFAULT_DEVICE_ID` に依存し、SWA ビルドにローカルDBの ID が焼き込まれていた。
  - backend: `POST /calls` の `device_id` を**省略可能**に（openapi.yaml v0.4.0・validator 通過）。
    省略時は当該家族の status=active なデバイスへ自動解決（複数件は最新 `registered_at` を採用・
    NULL は最古扱い）。0件は 404 `code="no_active_device"`・メッセージ
    「登録済みのデバイスがありません。相手の設定から登録してください」。明示指定時の挙動は従来どおり。
  - frontend: 発信から `NEXT_PUBLIC_DEFAULT_DEVICE_ID` 依存を除去（`createCall()` は device_id を
    送らない。`api-client.ts` の `DEFAULT_DEVICE_ID` エクスポートも削除）。
    404 `no_active_device` 時は「相手の設定から登録する」ボタン（登録リンク発行モーダルへの導線）を表示。
    `frontend/.env.example` に該当行は元々無し（`.env.local` 運用のみ）のため変更なし。
  - conftest 修正: `AZURE_SPEECH_KEY/REGION` をテスト時に空上書き（Agora と同じパターン。
    §13-7 で backend/.env に実キーが入ったことによる Speech テスト回帰4件を解消）。
  - 検証: pytest 91件（新規4件: 省略時解決・active無し404・複数件時最新採用・明示指定維持）／
    vitest 18件／`next build` 成功（成果物 grep で `DEFAULT_DEVICE_ID` 非混入・クラウドAPI URL
    焼き込みを確認）。
  - クラウド反映: api イメージ **`tvmvp-api:v2`**（明示バージョンタグ・latest 不変）で再ビルド→
    `ca-tvmvp-api` 更新（rev 0000005）。frontend 再ビルド→SWA 再デプロイ（配信ハッシュ一致確認）。
    **クラウドで `POST /calls`（device_id なし・Bearer）が 201 で自動解決されることを curl 確認済み**
    （検証で作成した call は `/end` で終了済み）。

- **STT 完了（2026-07-05・削減ラダー②解除＝Azure Speech による感情ワード検知）**:
  - Azure Speech リソース `speech-tvmvp-73bb`（**F0**・japaneast・タグ `app=tvmvp owner=mitsuru`）を作成。
    キー/region は `backend/cloud.env`（`.gitignore` 済み）に記録（コミット・ログ出力禁止）。
  - backend: `RealSpeechTokenProvider`（STS `issueToken` へ `Ocp-Apim-Subscription-Key` で POST →
    約10分の短命トークン）を追加。`AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` が両方非空なら Real、
    欠けたら Fake に DI 自動切替（Agora と同じパターン・`deps.get_speech_provider`）。
  - frontend: `AzureSttProvider`（`microsoft-cognitiveservices-speech-sdk`）。高齢者側リモート音声を
    WebAudio で **PCM16・16kHz** にダウンサンプリングして `PushAudioInputStream` へ供給 → `ja-JP` 連続認識。
    **感情ワード辞書**（`sttConfig.ts` の `EMOTION_WORDS`・フレーズリスト登録）でヒット検出。
    トークンは `/tokens/speech` から取得し **約9分ごとに更新**。`latest()` は直近約10秒の
    `stt_text` と `stt_labels` を返す。**best-effort**（SDK/トークン失敗は警告のみで STT 無効のまま継続）。
  - 配線（`index.ts`）: 感情ワードヒットで `handleTrigger` を `reason="stt"` で発火。**STT起因の発火には
    RMS と共有のクールダウン（4秒）** を適用（`passesSharedCooldown`）。metadata に `stt_text`/`stt_labels`
    を付与（STT 有効時のみ）。`window.__detection.state.stt`（enabled/lastText/labelHits/triggerCount）を追加。
    **→ `trigger_reason` に `stt` が入り得る**（従来は常に `rms`）。
  - 検証: vitest 18件（rmsTrigger6＋STT12: 感情ワードマッチング・共有クールダウン・PCM変換）／
    pytest 87件（Speech プロバイダ切替＋Real の HTTP モック8件を追加）／Playwright 2件
    （STT無効=Fake トークン経路で緑を維持）。ローカルで Speech キーを注入した uvicorn の
    `/tokens/speech` が Real トークン（Fake でない JWT）を返すことを確認。
  - クラウド反映: `ca-tvmvp-api` に secret `speech-key`＋`AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` を設定し
    api イメージ再ビルド→更新。frontend 再ビルド→SWA 再デプロイ。**クラウド `/tokens/speech` が Real
    トークンを返すことを確認済み**。
  - 実発話での感情ワード発火（「かわいいね」等）はユーザーの受入で確認する（Fake 音声では STT 認識は起きない）。

## 現在の状態（2026-07-04）

- **A1 完了（2026-07-04・Azure 実環境の構築とデプロイ）**:
  - RG `rg-001-gen12`（東日本）にコスト最小構成で構築。命名サフィックス `73bb`。
    全リソースに `app=tvmvp owner=mitsuru` タグ。リソース一覧・URL・月額は `infra/README.md`。
    秘密・接続情報は `backend/cloud.env`（`.gitignore` 済み・OpenAIキーは worker シークレット）。
  - PostgreSQL(B1ms/PG16)＋Storage(LRS・media/pipeline-jobs)＋ACR(Basic)＋
    Container Apps 環境 `cae-tvmvp`。`ca-tvmvp-api`（外部Ingress:8000・min1）と
    `ca-tvmvp-worker`（Ingressなし・**KEDA azure-queue で min0/max1**・1CPU/2GiB）。
    SWA(Free)に frontend 静的エクスポートを SWA CLI で配信。
  - **Azure OpenAI 成功**: `oai-tvmvp-73bb`（S0）に `gpt-4o`(2024-11-20) を
    **Regional Standard**（TPM10K）でデプロイ。`gpt-4o-mini` は japaneast で GlobalStandard のみ
    のため、PII 要件「Regional Standard 必須」を満たす `gpt-4o` を採用。
    `worker/stages/labels.py` の AzureOpenAILabelProvider を本実装（vision でタイトル/キャプション
    生成・失敗時は定型フォールバック）。クラウド検証で vision 生成タイトルを確認済み。
  - コード変更: backend `Dockerfile`／worker `Dockerfile`(apt で ffmpeg・BGM同梱)／
    `.dockerignore` 追加／`main.py` の CORS を `CORS_ALLOW_ORIGINS`（カンマ区切り）で環境変数化
    （localhost:3000 は既定維持）／`next.config.mjs` に `output:'export'`／
    `worker/main.py` に Azure SDK ログ抑制／labels 本実装＋stage2 が photo_paths を渡すよう微修正。
  - クラウドE2E（通話以外）を一巡: /healthz→登録リンク→devices/register→calls→
    upload-sas 実PUT→media/register→**worker がスケール0→1で起床**して score→候補提示
    （無表情ゲート確認）→selection→**worker が render**（1080p xfade・**BGM入り**）→
    album ready→video_sas_url を実DL→ffprobe で 30s/h264/**aac** 確認。SWA トップ 200＋API 疎通も確認。
    worker はキューが空になれば ScaledToZero に戻る。
  - 既知の注意: worker は 1080p 合成でメモリを食うため 2GiB 必須（1GiB は ffmpeg OOM=SIGKILL）。
    Agora シークレットは A1 未設定（ユーザーが `.env` の値で設定。手順は dev-setup §13-4）。

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
  - A1（Azure実環境）・A12（BGM実音源）・~~Azure Speech STT（削減ラダー②で除外中）~~
    → **2026-07-05 に②解除・実装済み**・Azure OpenAI vision（タイトル/キャプション）
- **M2 完了（2026-07-04・検知コア②＝感情検知・自動キャプチャ＋通話後同期）**:
  - frontend `modules/detection/`: `rmsTrigger.ts`（RMS発火判定の純粋ロジック=緩いEMA
    baseline(τ=4s)からの相対上昇＋VADゲート＋持続200ms＋クールダウン4s。支給初期値。
    チューニングは検収対象外）／`audioPipeline.ts`（WebAudio で rms_dB 50ms間隔＋
    MediaRecorder timeslice=1s リング保持→発火時に先頭ヘッダ＋発火前2秒〜後3秒を結合した
    webm スニペット。**チャンク結合の割り切り**をコメント明記）／`facePipeline.ts`
    （`@mediapipe/tasks-vision` FaceLandmarker で face_score。ロード失敗時は 0 で継続）／
    `videoRing.ts`（映像look-back 直近3コマ）／`burst.ts`（連写10枚＋look-back前置）／
    `storage.ts`（IndexedDB=`idb`。call_id別 photos/audio）／`sttProvider.ts`
    （インターフェース＋noop。当初は**削減ラダー②適用**、**2026-07-05 に②解除**＝
    `azureSttProvider.ts`/`sttConfig.ts` を追加）／`index.ts`（`attachDetection`＋
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
  3. ~~ホームの「さいきんのハイライト」カードに個別アルバムへのリンクが無い~~
     → **2026-07-05 フィードバック改善 第2段で解消**（`/album?highlight=<album_id>` 遷移）
  4. demo のダミー画像は番号なし単色（.venv に Pillow 追加で改善可）
  5. ~~家族側デバイス一覧APIなし（発信が NEXT_PUBLIC_DEFAULT_DEVICE_ID 焼き込みに依存）~~
     → **2026-07-05 に解消（POST /calls の device_id 自動解決）**。
     ~~GET /albums に写真なし（Phase 3 の制約と同じ）は残存~~
     → **2026-07-05 フィードバック改善 第1段で解消（GET /albums が photos を返す）**
- **Phase 3 完了（2026-07-03）**: frontend 内製UI本実装（`frontend/src/app/` 全6ページ
  ＋`lib/api-client.ts`・`lib/auth-stub.ts` 連携・`globals.css`）。
  backend は `app/main.py` に CORS（`allow_origins=["http://localhost:3000"]`）のみ追加。
  `next build` 成功・実backend（docker compose＋uvicorn＋seed済み）で
  elder register→standby ポーリング／select 候補表示／album 一覧・動画再生を
  ブラウザ実疎通確認済み（詳細は次項の制約・注意点を参照）。
  - ~~制約: 家族側にデバイス一覧APIが無い（1家族1デバイス固定設計）ため、
    発信ボタンの device_id は `frontend/.env.local` の
    `NEXT_PUBLIC_DEFAULT_DEVICE_ID`（seed.py 出力値）を暫定使用。~~
    → **2026-07-05 に解消**: POST /calls の device_id 省略時サーバ自動解決に変更し、
    フロントの環境変数依存を撤去（上記「既知課題#5 解消」参照）。
    複数デバイスの明示的な選択UIが必要になった場合はデバイス一覧APIの追加が必要（変わらず）。
  - 制約: `GET /albums` は写真一覧を返さないため、album ページは
    `selected_memory_ids` を `GET /calls/{call_id}/candidates` の結果と
    突合して sas_url を得ている（N+1・既存API内で実現）。
  - 環境固有の既知事象: このマシンの Next.js 14.2.0 + TypeScript 6.0.3 の組み合わせで
    tsconfig の `baseUrl` が非推奨エラーになったため削除。CSS の side-effect import
    型解決も効かなかったため `frontend/src/css.d.ts`（`declare module "*.css"`）を追加。
