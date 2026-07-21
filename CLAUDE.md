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

- **タイトル/キャプション生成の直 OpenAI API 利用（2026-07-04〜2026-07-06・解消済み）**:
  MVP 期間中の暫定として支給 OpenAI キー（直 API）を利用していたが、**2026-07-06 に
  クラウド worker を `LABEL_PROVIDER=azure`（`oai-tvmvp-73bb`・gpt-4o Regional）へ切り戻し済み**
  ＝顔画像は Azure 境界内で処理される設計どおりの状態。直 OpenAI の実装・キーは残置
  （ローカル開発では引き続き直 OpenAI が既定。切替は env のみ）。

## 委託と内製

- 委託コア①（通話基盤）: `frontend/src/modules/call/`＋backend トークン・着信・リンク系
- 委託コア②（検知キャプチャ）: `frontend/src/modules/detection/`
- 委託コア③（通話後パイプライン）: `frontend/src/modules/sync/`＋backend 一部＋`worker/`
- 内製: 選択UI（`select/`）・閲覧UI（`album/`、日付＋5枚一覧・タップ拡大）・認証（Entra ID
  本実装済み＝家族側の個人 Microsoft アカウントログイン。`backend/app/core/entra.py`＋
  `frontend/src/lib/auth.ts`＋`FamilyAuthGate`。クライアントID到着まで二段構えで
  `lib/auth-stub.ts` の固定トークンが併存）・DBスキーマ（`backend/app/db/`）
- 境界は API 契約・データ契約で固定（`docs/api/openapi.yaml`・`docs/data-contract.md` が正）

## リポジトリ構成

- `frontend/` Next.js（家族側＋高齢者側待受。UIシェル=支給物A8）
- `backend/` FastAPI（トークン・着信状態・メディア登録・候補・選択確定・ハイライト取得・SAS）
- `worker/` 2段階ワーカー（`stages/stage1_scoring.py`・`stage2_video.py`）。BGM=`assets/bgm/`（A12）
- `docs/` 支給物ドキュメント: `api/openapi.yaml`（A4）・`db-schema.md`（A3）・
  `data-contract.md`（A5）・`detection-params.md`（A6）・`architecture.md`・`wireframes/`
- `infra/` Azure構築メモ（A1）／`tests/` E2Eデモ台本（A9）

## 上位ドキュメント（このリポジトリ外・正本）

（2026-07-19 にリポジトリを `MyDocs/outputs/TV_MVP` から `toolmaker/apps/TV_MVP` へ移設したため、
以下は絶対パスで参照する。正本は引き続き MyDocs 側。）

- RFP: `/Users/mitsuru/Desktop/MyDocs/materials_used/TV電話サービス_RFP_MVP_コア技術外部委託バージョン.docx`
  （旧記載の `materials/` は現存せず。v2・テンプレートは
  `/Users/mitsuru/Desktop/MyDocs/outputs/tv-denwa-rfp/` にあり。チーム内バージョン docx は
  2026-07-19 の移設時点で MyDocs 内に見当たらず＝所在不明。別紙にワイヤーフレーム v0.9）
- 決定事項・変遷: `/Users/mitsuru/Desktop/MyDocs/wiki/syntheses/2026-07-02-tvphone-rfp-mvp-tech-review.md`
- アーキテクチャ・ToDo・図（シーケンス/DFD/クラス図）:
  `/Users/mitsuru/Desktop/MyDocs/wiki/syntheses/2026-07-02-tvphone-mvp-architecture-todo.md`

## 開発ルール

- 回答・コメント・ドキュメントは日本語
- `.env` は絶対にコミットしない。`.env.example` の秘匿値は空のまま。本番秘密は Key Vault＋マネージドID
- DB スキーマは `docs/db-schema.md`（クラス図準拠）が正。変更時は md → モデル → マイグレーションの順で同期
- API は `docs/api/openapi.yaml` が正。backend ルーターとの乖離を作らない
- 検知パラメータは `docs/detection-params.md` の初期値を使う（精度チューニングは検収対象外）
- 開発期間は実働2週間。遅延時の削減優先順位は RFP 10章（①映像look-back → ②STTトリガー →
  ③visionキャプション → ④BGM → ⑤着信ポーリング → ⑥高齢者側再生 → ⑦動画生成 の順で削る）

## 現在の状態（2026-07-21）

- **フロントエンド依存のメジャー更新（next 15.5 / React 19 / vitest 4）＋脆弱性掃討＋.snyk 整理
  完了（frontend のみ・ブランチ `deps/major-next15`・push 前でレビュー待ち／デプロイ未実施）**:
  統括承認済み。security/baseline から派生し、SCA 由来の既知 high を上流更新で解消した。
  - **Phase 1**: `next` 14.2.35 → `^15.5.20`、`react`/`react-dom` 18.3.0 → `19.2.7`（App Router のため
    React 19 必須）、`@types/react-dom` 19.2.3 追加。lockfile は CI と同じ npm 10（Node 20 系）で
    再生成（EUSAGE 回避。`npx npm@10 install`）。**コード修正は不要**（`output:"export"` 構成のため
    Next 15 のサーバ系 breaking の影響なし・React 19 で型エラー 0）。build 9/9・unit 144 PASS。
  - **Phase 2**: `vitest` ^2.1.9 → `^4.1.10`（同梱 vite 5.4→**8.1.5**）。vitest.config は
    include＋environment:"node" のみで設定 breaking なし。unit 144 PASS。
  - **Phase 3（overrides で推移的依存の脆弱性を固定）**: `frontend/package.json` の `overrides` に
    以下を追加した。
    - `postcss ^8.5.10`（next 15 同梱 8.4.31＝GHSA-qx2v-qp2m-jg93 → 8.5.21 に dedupe）
    - `uuid ^11.1.1`（speech-sdk 経由 9.0.1＝GHSA-w5hq-g745-h8pq。speech-sdk は `uuid.v4()` のみ
      使用し v11 でも named export・CJS を維持＝無破壊）
    - `ws ^8.21.1`（speech-sdk 経由 8.21.0＝SNYK-JS-WS-17988732。npm audit 未検出・snyk test 検出）
    - **override の解除条件（重要）**: これらは脆弱性対応の**一時固定**である。親の
      `microsoft-cognitiveservices-speech-sdk`（uuid/ws の供給元）や `next`（postcss の供給元）が
      **同等以上のバージョンを自ら宣言したら、この override を削除し依存更新で追随する**
      （override は上流が追いつくまでの橋渡しであり、恒久固定しない）。`npm ls uuid ws postcss` で
      供給元の宣言が override 下限以上になったことを確認できたら外す。
    - 結果 `npm audit` は **0 vulnerabilities**。
  - **Phase 4（.snyk 整理）**: 従来期限付き受容していた next high 7件・ws 1件を撤去。ただし
    `snyk test`（org nonooktk・認証済み）で next@15.5.20 に**新規 high `SNYK-JS-NEXT-15105315`**
    （fix は next@16.1.5＝メジャー）が判明したため、統括判断 (B) で**当該 1 件のみ期限付き受容**
    （expires 2027-01-21・reason=静的 export 構成で悪用前提 PPR/minimal mode 非該当）。next 16 更新の
    別タスクで解消予定。`snyk test --severity-threshold=high --policy-path=.snyk` が exit 0。
  - **CI**: `.github/workflows/security.yml` の setup-node を `node-version: "20.19"`（vite 8 の
    Node 要件 ^20.19.0 満たす）へ明示。ジョブ名（Required checks 一致）は不変。
  - **未実施**: push・PR・Dependabot 操作・デプロイはしていない（ワーキングツリー/ローカルコミットのみ）。
    backend/worker は無変更。

## 現在の状態（2026-07-20）

- **セキュリティ残課題 F-3（High）・F-7（Low）・F-4（Low）＋ next パッチ更新（Medium・SCA）の対応＋本番デプロイ完了
  （backend=tvmvp-api:v12・frontend=SWA 再デプロイ）**: 統括承認済みの「安全な範囲の修正」。
  F-8/F-9 は据え置き。
  - **F-3（dev 固定トークンの本番失効）**:
    - コードガード: `backend/app/api/deps.py::require_family` の dev トークン照合を
      `if settings.DEV_FAMILY_TOKEN and token == settings.DEV_FAMILY_TOKEN:` に変更
      （env を空にした時に**空文字トークンが裏口とマッチする穴**を塞ぐ）。
    - Settings のデフォルト化: `backend/app/core/config.py` の `DEV_FAMILY_TOKEN: str` を
      **`= ""`（デフォルト空）** に変更。**これが無いと env 除去時に pydantic-settings の必須
      検証が失敗しコンテナが起動しない**ため、env 除去の前提として必須の修正（F-3 と整合）。
    - 本番失効: cloud `ca-tvmvp-api` から **`DEV_FAMILY_TOKEN` env を除去**
      （`az containerapp update ... --remove-env-vars DEV_FAMILY_TOKEN`）。ガードと合わせ本番は
      Google/Entra のみで認証。
    - テスト: `backend/tests/test_idor_manual.py` に `test_dev_token_disabled_when_env_empty`
      （`get_settings` を DEV_FAMILY_TOKEN/GOOGLE/ENTRA すべて空へ上書きし、旧 dev トークン・
      空 Bearer・不正 Bearer・ヘッダ無しがすべて **401** をパラメタライズで検証）を追加。既存の
      `test_dev_token_backdoor_is_open_locally`（ローカルは 200）は維持。
  - **F-7（API に nosniff）**: `backend/app/main.py` に全レスポンスへ
    `X-Content-Type-Options: nosniff` を付与する HTTP ミドルウェアを追加。テストは新規
    `backend/tests/test_security_headers.py`（`/healthz`・`/openapi.json`・認証エンドポイントに
    nosniff が付くこと）。
  - **F-4（依存バージョン固定）**: `backend/requirements.txt` の直接依存を `requirements.lock.txt`
    の実バージョンで `==` ピン留め（extras の推移的依存の厳密版は lock を参照とコメント明記）。
    Docker ビルド（ACR）で解決を検証。
  - **next パッチ更新（SCA）**: `frontend` の next を **14.2.0 → 14.2.35**（`package.json`／
    `package-lock.json` 更新）。14.2.35 は 14.2.x 最新パッチでレポートの 14.2.0 Critical/High を
    解消（残 advisory は Image Optimizer/RSC/Middleware 等＝`output:"export"` の本アプリで未使用）。
  - **検証**: backend `.venv-scan` pytest **204 passed**（197→+7: F-3 4・F-7 3）／frontend
    `npx vitest run` **144 passed**／クリーンコピー（`.env.local` 非同梱・`.env.production` のみ）で
    `npx next build` **9/9**・バンドル検証（cloud API 焼込み／localhost・dev-fixed-token 漏れなし／
    Google・Entra クライアントID あり）。
  - **デプロイ**: backend は F-3+F-7+F-4 を **`tvmvp-api:v12`**（v11 は config デフォルト化前の
    中間ビルドで置換。既存タグ非上書き）→ `az containerapp update` → **rev `ca-tvmvp-api--0000016`
    （v12・100% traffic）** → `DEV_FAMILY_TOKEN` env 除去。確認: env に DEV_FAMILY_TOKEN **無し**・
    `/healthz` **200**（空デフォルトで正常起動）・`/healthz`/`/openapi.json` に **nosniff**・未認証/
    空 Bearer/旧 `dev-fixed-token` すべて **401**（裏口失効）。frontend は next 14.2.35 ビルドを
    SWA production へ再デプロイ（デプロイトークンはシェル変数直渡し）→ `curl -I` で F-6 ヘッダ
    （X-Frame-Options/CSP/Permissions-Policy 等）が引き続き配信・配信チャンク更新を確認。本番実機で
    サインイン画面（Google 公式ボタン＋MSAL）が CSP 下で正常描画（回帰なし）。
  - 秘匿値は一切出力・コミットしていない。git commit/push は未実施（ワーキングツリー変更のみ）。

- **セキュリティ指摘 F-10（Medium・本番前必須／QAレビューで F-1 と一対で検出）の修正＋本番デプロイ完了
  （backend のみ・Container App）**: `backend/app/api/media.py::register_media` が
  `item.storage_key` を無検証で Memory に保存していたため、家族Bが自分の call に
  `storage_key=families/{家族A}/…` の memory を register → `GET /calls/{id}/candidates` が
  同 storage_key の read SAS を発行 → **他家族 Blob の read SAS を取得できる芽**（F-1 の read 版）
  が残っていた。
  - **修正**: `_owned_call` 直後（冪等チェックの前）で、全 `item.storage_key` が当該通話の
    `call_prefix(call.family_id, call.id)`（＝`families/{family_id}/calls/{call_id}/`。upload-sas と
    同じヘルパ）配下であることをサーバ側検証。**空・`..` を含む（遡上）・プレフィックス外**は
    `400`（`code=invalid_storage_key`）で拒否。越境 read の芽を根絶。
  - **テスト**: `backend/tests/test_idor_manual.py` に3件追加＝`test_register_rejects_foreign_prefix_storage_key`
    （他家族プレフィックスの storage_key を含む register が **400**）／`test_register_rejects_traversal_storage_key`
    （`..` 含みが 400）／`test_register_accepts_own_prefix_storage_key`（自家族プレフィックスは従来どおり **201**）。
    既存 `test_call_end.py::test_end_does_not_break_media_register_transition` はダミー
    `families/x/…`（プレフィックス外＝新検証で 400）を使っていたため、テストの主眼（end×register
    の ended 遷移共存）を保ったまま storage_key を実プレフィックスへ追随修正（F-1 の `test_upload_sas`
    更新と同種）。
  - **検証**: `backend/.venv-scan` で `python -m pytest tests/ -q` → **197 passed**（194→+3）。
  - **デプロイ**: `az acr build --registry acrtvmvp73bb --image tvmvp-api:v10`（latest 非上書き）→
    `az containerapp update -g rg-001-gen12 -n ca-tvmvp-api --image .../tvmvp-api:v10` →
    **新リビジョン `ca-tvmvp-api--0000013`（v10・100% traffic）**。`/healthz` **200**・未認証
    `/media/register`・`/albums` とも **401**（認可健全）を確認。旧 rev 0000012（v9）は退役。
    秘匿値は一切出力・コミットしていない。

- **セキュリティ指摘 F-1（Blocker）・F-6（Medium）の修正＋本番デプロイ完了
  （backend＋frontend／SWA・Container App 両方デプロイ済み）**: レポート
  `docs/SECURITY_REPORT_2026-07-19.md` の残課題のうち、本番前必須の2件を修正・出荷した。
  - **F-1（アップロードSASの過剰スコープ）**: `backend/app/services/blob.py::upload_sas_url`
    を `generate_container_sas`（コンテナ全体 create+write）から **`generate_blob_sas`
    （当該 storage_key 1個だけの create+write・有効期限は現行 `_UPLOAD_TTL`=1時間を維持）**
    へ変更。これでSASトークン自体が単一Blobにしか効かず、他家族プレフィックスへの越境PUTが
    原理的に不可能になった（read側 `view_sas_url` と同じ手法）。あわせて `storage_key` が
    引数 `call_prefix` 配下でない場合は `ValueError` を送出する防御的検証を追加。docstring も
    実態へ更新。未使用になった `generate_container_sas` / `ContainerSasPermissions` の import を削除。
    - **テスト**: `backend/tests/test_media.py` に2件追加＝`test_upload_sas_is_single_blob_scoped`
      （実 BlobService でSASを発行し `sr=b`〈単一Blob〉・権限 `sp`=create+write のみ・発行先URLが
      当該 storage_key を指すことを検証。ネットワーク不要の純粋なSAS生成）／
      `test_upload_sas_rejects_key_outside_prefix`（プレフィックス外キーで `ValueError`）。既存
      `test_upload_sas`（Fake ベース）と `test_idor_manual.py`（越境防御31/11件）は無変更で維持。
    - **検証**: `backend/.venv-scan` で `python -m pytest tests/ -q` → **194 passed**
      （旧: worker テスト用に `.venv-scan` へ `Pillow` を追加導入した）。
    - **デプロイ**: `az acr build --registry acrtvmvp73bb --image tvmvp-api:v9`（latest 非上書き）→
      `az containerapp update -g rg-001-gen12 -n ca-tvmvp-api --image .../tvmvp-api:v9` →
      **新リビジョン `ca-tvmvp-api--0000012`（v9・100% traffic・RunningAtMaxScale）**。
      `/healthz` **200**・未認証 `/albums`・`/media/upload-sas` とも **401**（認可健全）を確認。
      旧 rev 0000011（v8）は deprovisioning。
  - **F-6（セキュリティヘッダ未設定）**: `frontend/public/staticwebapp.config.json` を**新設**
    （静的エクスポートで `out/` 直下へ配置され SWA が読む）。`globalHeaders` に
    `X-Frame-Options: DENY`／`X-Content-Type-Options: nosniff`／`Strict-Transport-Security:
    max-age=31536000; includeSubDomains`／`Referrer-Policy: strict-origin-when-cross-origin`／
    `Permissions-Policy`（camera/microphone=self・他は絞る）／`Content-Security-Policy` を設定。
    - **CSP 設計方針（アプリ非破壊が絶対条件）**: script/object/base/frame は締める一方、
      **`connect-src` は `'self' https: wss: blob: data:` と広く許容**した。理由は Agora Web SDK が
      メディアゲートウェイへ**動的な生IP/wss**で接続するため、connect-src を厳格化すると通話が壊れる
      から。XSS 実行の主防御は `script-src`（`'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:
      accounts.google.com *.gstatic.com cdn.jsdelivr.net`＝Next静的エクスポートの都合で
      unsafe-inline、MediaPipe WASM 用に wasm-unsafe-eval）と `object-src 'none'`・
      `base-uri 'self'`・`frame-ancestors 'none'` で担保。`frame-src` は Google/MSAL
      （accounts.google.com・login.microsoftonline.com・*.msftauth.net）、`img-src` に
      `*.blob.core.windows.net`（アルバムSAS画像）等を許可。
    - **CSP 検証**: SWA CLI エミュレータ（`swa start ./out`）で実ヘッダを適用して配信し、ブラウザで
      サインイン画面を表示 → **Google 公式サインインボタン（GIS 由来・accounts.google.com の
      iframe）と Microsoft ボタンが CSP 下で正しく描画**・インラインスタイル適用・React
      ハイドレーション（`/call`→サインインゲートへのリダイレクト）成立を確認。**デプロイ後の
      本番実機**（`gray-dune-0117e4d00`）でも同様に Google 公式ボタン＋MSAL ボタンの描画を確認。
      通話中の Agora メディア接続・MediaPipe ランタイムロードは2者通話が必要なため実機未検証だが、
      Agora は connect-src の広い許可でカバー、MediaPipe はロード失敗時 `face_score=0` で通話継続
      （facePipeline 設計）＝CSP に起因して通話自体が壊れる経路はない。
    - **frontend ビルド/デプロイ**: 本セッションのツール権限で `.env.local` を退避（mv）できない
      ため、`.env.local` を含めない**クリーンコピーを scratchpad に作成**（`.env.production` のみ・
      公開値のみのリポジトリ追跡ファイル）→ `next build`（9/9）で本番バンドル生成。バンドル検証で
      **cloud API URL 焼込みあり・localhost:8000 漏れなし・dev-fixed-token 漏れなし**・Google/Entra
      クライアントID あり（本番現行値と一致）を確認。`out/staticwebapp.config.json` 生成を確認 →
      `npx @azure/static-web-apps-cli deploy ./out`（デプロイトークンは
      `az staticwebapp secrets list -g rg-001-gen12 -n swa-tvmvp-73bb` からシェル変数で直渡し・
      ファイル/ログに非出力）で **production へ配信**。配信後 `curl -I` で `/`・`/call/` とも
      新ヘッダ（X-Frame-Options・CSP・Permissions-Policy 等）が付くことを確認。
  - **未対応（残課題）**: レポートの F-3（dev トークン本番失効）・next 14.2.35 パッチ更新・
    F-9（DB ネットワーク強化）・認証済み DAST 等は今回対象外（別途）。**秘匿値（.env / cloud.env）は
    一切出力・コミットしていない**。git commit/push は未実施（ワーキングツリー変更のみ）。

## 現在の状態（2026-07-19）

- **家族側 Microsoft サインイン不具合のデバッグ支援＝認証エラーの可視化と二次障害の自動復旧
  （frontend のみ・SWA 本番デプロイ済み）**: 本番 SWA
  （https://gray-dune-0117e4d00.7.azurestaticapps.net）で「Microsoft でサインイン」→
  認証完了 → アプリに戻るとサインイン画面のまま（`/token` 交換前に `handleRedirectPromise`
  が失敗／取りこぼし）となる不具合の**原因コード（AADSTS 等）を可視化する**のが目的。
  従来コードはエラーを catch で完全に握りつぶしており原因が外から見えなかった。
  - **変更ファイル**: `frontend/src/lib/auth.ts`／`frontend/src/components/FamilyAuthGate.tsx`。
  - **auth.ts**: 純粋ヘルパーを追加。`formatAuthError`（name / errorCode / errorMessage を
    取りこぼさず AADSTS コードを含む1行へ整形）・`isInteractionInProgressError`（MSAL の
    `interaction_in_progress` 検出）・`clearMsalInteractionState`（`msal.` で始まり
    interaction を含むキーだけを sessionStorage / localStorage から削除）。あわせて `getMsal`
    の初期化 Promise を**失敗時に破棄**し（`initPromise.catch(()=>initPromise=null)`）、
    一時状態クリア後の再試行が同じ失敗 Promise を掴み続けないようにした。
  - **FamilyAuthGate.tsx**: 初期化（`handleRedirectPromise`）とサインインボタン
    （`handleMicrosoftSignIn`→`login`）の catch で、握りつぶしをやめて①`console.error` に
    全文出力②サインイン画面に赤字の小さめテキスト（`data-testid="auth-error"`）でエラー全文表示。
    `interaction_in_progress` 検出時は一時状態をクリアし、サインインボタンでは**1回だけ自動
    リトライ**（再失敗時は「（もう一度お試しください）」付きで表示）。高齢者側（/elder/*）へ
    MSAL を読み込ませない現行構成・静的エクスポート互換（トップレベル副作用なし・遅延 import・
    window ガード）は不変。
  - **検証**: vitest **144件**（136→+8: `tests-unit/authError.test.ts`＝formatAuthError 4・
    isInteractionInProgressError 2・clearMsalInteractionState 2。DOM は node 環境向けに最小
    Storage を window へ差し込んで検証）／**tsc 0エラー**／**next build 9/9**。
  - **デプロイ**: docs/dev-setup §13-3 の標準手順（`.env.local` を `mv` で退避 →
    `.env.production` 自動読込で `npx next build` → デプロイトークンをシェル変数経由で SWA CLI
    へ直渡し → `.env.local` 復元）で SWA production に配信済み。配信中の共有チャンク
    `_next/static/chunks/119-856516ff04a81ffe.js`（HTTP 200）に `auth-error`／
    「サインインでエラーが発生しました」／「もう一度お試しください」が含まれることを
    curl+grep で確認済み。backend/worker は無変更。git commit/push は未実施（ワーキングツリー変更のみ）。
  - **次アクション（統括）**: シークレットウィンドウで本番 SWA を開き Microsoft で再サインイン →
    戻った画面に赤字で表示されるエラー全文（AADSTS コード）を共有いただければ、行き先の原因
    （リダイレクトURI不一致・同意・nonce/state 等）を特定できる。

## 現在の状態（2026-07-18）

- **検知トリガーの再構成（Phase A・Round 1 実測に基づく設計見直し／frontend のみ・
  ローカルビルド検証まで＝SWA/コンテナ未デプロイ）**: 実地テスト Round 1（3セッション・
  231発火）の分析で判明した①重心=誤発火78%・通常発話の92%の時間で閾値1.3超過（特徴量として
  不成立）②RMS発話基準+12dBが低すぎ③顔絶対値0.7は普通の笑顔で超える、を受けて再構成した。
  実装の正は `frontend/src/modules/detection/`（rmsTrigger.ts／centroidTrigger.ts／
  faceTrigger.ts／index.ts／measurementLog.ts）＋`app/call/page.tsx`。
  - **①重心トリガーの停止（既定 enabled=false・計測は継続）**: `DEFAULT_CENTROID_PARAMS` に
    `enabled: false` を追加し発火経路を既定無効化（`push` は中央値窓・sample()/snapshot() を
    従来どおり更新するが、発火イベントを一切返さない＝計測は継続）。パラメータで再有効化可能。
    計測ログのサンプルに `centroid_ratio_median`（その1秒の基準比の中央値＝平滑値。ピークと
    併記）を追加（Phase B で平滑重心の識別可能性を検証する材料）。デバッグパネルの重心セクション
    に「停止中（計測のみ）」表示を追加。
  - **②RMS 閾値の引き上げ**: `riseThresholdSpeechDb` 12→**20**／`riseThresholdProvisionalDb`
    24→**26**（elder・family 両系統＝DEFAULT_RMS_PARAMS 共有）。
  - **③スパイク棄却（発火確認窓 `confirmWindowMs=150`）**: sustain 成立後、即発火せず150msの
    確認窓を張り、その間に非発話（ノイズゲート割れ or VAD床割れ）へ落ちたら破裂音（咳・くしゃみ・
    生活音）とみなして発火を破棄する。発火は最大150ms遅れるが look-back リングで写真は
    取りこぼさない（設計意図をコードコメントに明記）。破棄は `snapshot().spikeRejectedCount`／
    計測ログの `spike_rejected` イベント（elder/family 別 source）に記録（C1台本の効果測定用）。
    `confirmWindowMs<=0` で従来どおり即発火（後方互換）。
  - **④顔トリガーの「変化」化**: 絶対値0.7×300ms → `score>=0.85`（絶対）**かつ**
    `score-baseline>=0.4`（本人ベースライン比の上昇。ベースライン=顔スコアの直近10秒ローリング
    中央値・既存 RollingMedian 流用）を **500ms 持続**（`faceTriggerScore=0.85`／
    `faceRiseDelta=0.4`／`faceSustainMs=500`／`faceBaselineWindowMs=10000`）。無表情→笑顔の
    「変化」で発火し、ずっと笑顔（変化なし）では発火しない。リアームは既存踏襲（0.85未満に戻るまで）。
    計測ログに `face_baseline`（本人ベースラインの1秒毎の現在値）を追加。
  - **⑤シナリオマーカー**: 計測UI（`NEXT_PUBLIC_MEASUREMENT_UI=1` 時のみ）に打刻UI（セレクト
    A1〜A7・B1〜B8・C1〜C3・自由入力＋「打刻」ボタン）を追加。押すと計測ログの events に
    `{type:"marker", label, t}` を記録する（Round 2 の集計自動化）。既存📊ボタンの近く（左下）に
    通話の邪魔にならない小ささで配置。`DetectionHandle.recordMarker(label)` を新設。
  - **検証**: vitest **136件**（126→+10: rmsTrigger スパイク棄却5・centroidTrigger 既定停止3・
    measurementLog（centroid_ratio_median／face_baseline／spike_rejected／marker／リング）5。
    既存の旧閾値参照〈provisional 24→26・speech 12→20〉・確認窓ぶんのサンプル数・顔トリガーの
    「変化」条件・重心 enabled=true 明示は新仕様へ更新。既存テストの dummy RmsTriggerState /
    events union も追随修正）／**tsc 0エラー**／**next build 9/9**。
  - **判断に迷った点**: (a) 確認窓の発火は「保留していた sustain 成立時点の値（rmsDb/rise/
    baseline）」で行い、現在フレーム値では発火しない（写真は look-back で過去に遡るため peak
    時点の metadata を残すのが自然）。(b) 重心停止は `push` の firing ブロックだけを
    `enabled &&` で塞ぎ、sustainedMs のリセットもしない＝観測（sample/snapshot）は完全に従来
    どおり継続する方式にした（計測材料を欠損させないため）。(c) 顔ベースラインは高スコア
    フレームも中央値窓へ入れる（10秒窓では短い笑顔は少数派で中央値をほぼ動かさず、逆に長く
    笑い続けると中央値が上がって自然に再発火しにくくなる＝過検出抑制になるため）。
  - **未実施（明記）**: **SWA・コンテナへのデプロイは今回未実施**（本作業はローカルビルド検証
    まで。机上検証レポート提示後に別途実施する指示のため）。backend/worker は無変更。

## 現在の状態（2026-07-10）

- **Entra ID サインイン先（authority）の環境変数切替対応（2026-07-10・frontend のみ）**:
  `frontend/src/lib/auth.ts` の `AUTHORITY` をハードコード（`.../common` 固定）から
  `NEXT_PUBLIC_ENTRA_AUTHORITY || ".../common"` へ変更し、環境変数でサインイン先テナントを
  切替可能にした。背景: Entra クライアントID **`9a6338d6-b944-45bd-a603-1f0cf7ebae38`**（公開値）
  発行済み・アプリ登録は検証期間中は `admintech0` テナント（テナントID
  `55f735cd-b170-4cfe-91ee-0b08d30d87e8`）にシングルテナント登録済みのため、`.env.production` に
  `NEXT_PUBLIC_ENTRA_CLIENT_ID` と `NEXT_PUBLIC_ENTRA_AUTHORITY`（テナント固定URL）を設定して
  再ビルド・デプロイし、API コンテナに `ENTRA_CLIENT_ID` を設定すれば有効化できる（手順は
  `docs/dev-setup.md` §13-8(B) を更新済み）。マルチテナント移行時は authority を空へ戻し
  （既定 common）、あわせてアプリ登録の対象アカウント種別を変更する必要がある（同 §13-8(B) 末尾に
  注記）。検証: vitest 108件全パス（既存回帰・auth.ts に単体テストなし）／tsc 0エラー／
  `next build` 成功。**`.env.production`／`.env.local` への値設定は本作業環境のツール権限
  （該当ファイルへの Read/Write/Bash アクセスがいずれも拒否される設定）により実施できず、
  ユーザー側での設定が必要**（`frontend/.env.example` への追記可否は別途確認）。

- **ノイズゲート（固定 -50dB）＋声トリガーの両側化（family lane）実装完了
  （2026-07-10・frontend＋worker軽微／SWA 再デプロイ済み）**:
  - **①ノイズゲート（固定 -50dB）**: `rmsTrigger.ts` の `DEFAULT_RMS_PARAMS` に
    `noiseGateDb: -50` を追加した。`RmsTrigger.push()` は先頭で `gated = rmsDb < noiseGateDb`
    を判定し、**vadFloorDb（動的・家族側は自動追従）の値に関わらず**ゲート未満は常に
    「完全な無音」として扱う（既存の VAD ゲート分岐と合流させ、sustain 加算なし・baseline
    学習に入らない・発話判定は常に false・重心トリガーへも `isSpeech=false` で渡し持続を
    リセットする、という4点を1つの early return で保証）。あわせて `audioPipeline.ts` の
    適応 VAD 床クランプを `[-70,-45]` → `[-50,-45]` に変更し、ノイズゲートと下限を揃えて
    「-50dB 未満には絶対反応しない」ことを二重に保証した。`RmsTriggerState`（snapshot）に
    `noiseGateDb`／`gated` を追加し、`call/page.tsx` のデバッグパネル（「発火」「パラメータ
    現在値」セクション）に表示。計測ログ（`measurementLog.ts`）のサンプルに `gate_ratio`
    （その1秒でゲート未満だったフレーム率）を追加した。**送信音声そのものには一切手を
    加えていない（聞こえ方は不変）**。
  - **②声トリガーの両側化（family lane）**: 家族側ローカルマイク音声に第2の検知系統
    （family lane）を追加した。`index.ts`（`attachDetection`）に `familyRmsTrigger`／
    `familyCentroidTrigger`／`familyAudioPipeline` を elder レーン（従来の高齢者側リモート
    音声）とは**完全に別インスタンス**で持ち、baseline・発話累計・ノイズフロア推定・
    ノイズゲート・リアームのすべてを独立に学習する。`agoraCall.ts` に
    `onLocalAudioTrack`（join 直後・自動ゲイン適用前の生マイクトラックを渡す差し込み口）を
    追加し、`call/page.tsx` が `localAudioTrackRef` 経由で `attachDetection` の
    `familyAudioTrack` へ配線した（elder の video/audio が揃った時点の値をそのまま渡す
    best-effort。タイミング上ほぼ確実に join 直後の family トラックが先に揃っている）。
    **STT は高齢者側のみ**（family lane には付けない）。**クールダウンは全系統共有**:
    `handleTrigger` に `source: "elder" | "family"` 引数を追加したが、共有クールダウン判定
    （`lastTriggerAtMs` 1本・`passesSharedCooldown`）と `busy` 再入防止は従来どおり
    関数全体で1つだけなので、elder の rms/centroid/stt と family の rms/centroid の
    どれが発火しても実装上そのまま横断的に8秒間再発火を抑止する（コード変更は
    `source` を通知先・スナップショット選択に使うだけで、クールダウン機構自体は拡張不要
    だった）。発火時の写真連写は**現状どおり高齢者側 video リングから**（両側連写は
    次フェーズ）。発火イベント・写真 metadata に `trigger_source`（`"elder"`／`"family"`。
    既存データは elder 扱いのデフォルト）を追加。デバッグパネルに「家族側マイク（第2系統）」
    セクション（rms/baseline/rise/mode/armed/重心比の現在値）を追加。計測ログのサンプルに
    `family_rise_peak_db`／`family_centroid_ratio_peak` を追加し、発火イベントに
    `trigger_source` を記録するよう `measurementLog.recordTriggerStart` に `source` 引数
    （既定 "elder"）を追加した。家族側系統の初期値は高齢者側と同一（noiseGate 含む）。
  - **worker（`call_context.py`）**: ラベリング文脈に `has_family_trigger` を追加し、確定5枚の
    いずれかが `trigger_source == "family"` なら「家族側の歓声や声の盛り上がりもこの瞬間の
    きっかけになった」という文脈行を1つ足す（stage1 のスコアリング等の判定ロジックは無変更）。
  - **検証**: vitest **108件**（97→+11: ノイズゲート5件〈rmsTrigger.test.ts〉・family lane
    独立性/共有クールダウン横断6件〈新規 familyLane.test.ts〉。既存 vadFloor.test.ts の
    クランプ下限テストを -70→-50 の新仕様へ更新）／tsc 0エラー／`next build` 9/9（配信
    チャンクに「家族側マイク（第2系統）」「noiseGateDb」「trigger_source」等の新文字列を
    grep 確認）／**pytest 172件**（165→+7: `test_worker_call_context.py` に
    `has_family_trigger` の判定3件＋`build_prompt` への反映2件を追加。既存の call_context
    テストは無変更で回帰確認）。
  - **docs 更新**: `detection-params.md`（ノイズゲート・家族側系統セクション＋変更履歴・
    計測ログのフィールド説明更新）／`data-contract.md`（`trigger_source` キー追記。あわせて
    重心トリガーの共有クールダウン記載を旧「4秒」から現行「8秒」へ修正）。
  - **SWA 反映**: `docs/dev-setup.md` §13-3 の標準手順で実施（`.env.local` は中身を読まず
    `mv` で退避 → `.env.production` 自動読込ビルド → SWA CLI デプロイ
    （デプロイトークンは `az staticwebapp secrets list` から**シェル変数で直接パイプ**し、
    ファイルには書いていない）→ `.env.local` 復元）。配信中
    （`gray-dune-0117e4d00.7.azurestaticapps.net`）の `/call` チャンクに「家族側マイク
    （第2系統）」「noiseGateDb」「trigger_source」「family_rise_peak_db」
    「family_centroid_ratio_peak」が含まれることを curl+grep で確認（root/call とも 200）。
    backend/worker はイメージ再ビルド不要（worker の変更はコード1ファイルのみで未デプロイ・
    次回 worker イメージ更新時に含める想定）。
  - **判断に迷った点**: family lane のトラック到着タイミング（elder の video/audio 到着時点で
    family の生マイクトラックが未取得だった場合の扱い）。家族側ローカルマイクは join 直後
    （相手が「でる」より前）に取得できるため通常は elder 側より確実に先着するが、万一
    タイミングがずれて未取得のまま attach してしまっても、family lane を諦めて elder
    レーンのみで検知を継続するだけ（elder 検知・通話自体には影響しない best-effort）とし、
    attach 後の動的な family トラック追加は次フェーズ扱いとした（現状のタイミングでは
    発生しにくく、複雑化を避ける判断）。

## 現在の状態（2026-07-08）

- **計測ログのエクスポート機能 実装完了（frontend のみ・ワーキングツリーに変更あり／
  push はしない）**: トリガーパラメータ設計の実地テストで「全シナリオでの rise / 重心比の
  分布」と「全発火イベントの詳細」を後から集計できるようにする、読み取り専用オブザーバー。
  新規 `frontend/src/modules/detection/measurementLog.ts`（`MeasurementLog` クラス。1秒ごとの
  サマリサンプル＝**その1秒間のピークホールド**〈rise_peak_db・centroid_ratio_peak〉＋現在値
  〈rms_db/baseline_db/mode/speech_accum_ms/speech_median_db/armed/vad_floor_db/
  noise_floor_db/speech_ratio/centroid_hz/centroid_baseline_hz/auto_gain_db〉・全発火イベント
  〈発火瞬間の rmsTrigger/centroidTrigger snapshot 全体＋完了時 photo_count・部分保存
  partial_save〉。リング上限 samples=3600件／events=200件）。`index.ts` の `onRms`／
  `onCentroid`／`handleTrigger` から**snapshot 取得と onEvent 相当のタイミングのみ**でフック
  し、検知本体のロジックには一切書き込まない（読み取り専用）。`attachDetection` の戻り値
  `DetectionHandle` に `exportMeasurementLog()`／`clearMeasurementLog()`／
  `measurementLogCounts()` を追加。家族側 `/call` のデバッグパネルに「計測ログDL」
  （Blob+a.download で `measurement-log-<callId>-<t>.json`）・「ログクリア」ボタンと
  記録件数（samples/events）の小表示を追加（ボタン表示はパネル限定・記録自体はデバッグ
  モードに関係なく通話中は常時行う）。検証: vitest **90件**（81→+9: ピークホールド・
  1Hz間引き・リング上限〈samples/events〉・シリアライズ・イベント記録〈開始→完了の紐付け・
  複数発火の取り違えなし〉・counts()/clear()）／tsc 0エラー／`next build` 9/9（配信チャンクに
  「計測ログDL」を grep 確認）。docs/detection-params.md 末尾に「計測ログ」セクション追記。
  **本番 SWA への反映**: dev-setup.md §13-3 の標準手順（`.env.production` 自動読込ビルド→
  SWA CLI デプロイ）で実施。

- **ワンタップDL導線＋通話終了後の回収導線 実装完了（2026-07-08・frontend のみ・
  ワーキングツリーに変更あり／push はしない）**: 上記の計測ログ機能に、①通話中にその場で
  即ダウンロードできる常設ボタンと、②DLし忘れ・タブクラッシュ対策の IndexedDB 永続化＋
  ホーム画面からの事後回収を追加した。
  - **①常設「📊ログ」ボタン**（`app/call/page.tsx`）: 画面左下（右下の既存デバッグトグルと
    衝突しない位置）に常時表示する小ボタン（`data-testid="measurement-quick-download"`）。
    デバッグパネル内の既存「計測ログDL」と同じ `handleMeasurementDownload` を共有し、
    タップで即 Blob ダウンロードする。
  - **②通話終了後の回収導線**: 新規 `frontend/src/modules/detection/measurementLogStorage.ts`
    （`idb` パターン。既存 `storage.ts` の `DetectionDB`／`DB_VERSION` には一切触れず、
    **別DB `tvmvp-measurement-log`** として新設。ストア `logs`〈keyPath=callId〉＋
    `byUpdatedAt` インデックス）。`index.ts` の `attachDetection` 内に**10秒間隔の
    setInterval** を追加し `measurementLog.toExport()` を渡してフラッシュ、`detach()` 内でも
    もう一度確定フラッシュする（検知本体の `onRms`／`onCentroid`／`handleTrigger` の
    発火判定ロジックは無変更。追加したのはタイマーのセットアップ・クリアと永続化呼び出しのみ）。
    **設計判断（upsert＝完全スナップショット置き換え。差分追記ではない）**: フラッシュは
    「その時点の `toExport()` の完全スナップショットで当該 call_id のレコードを丸ごと
    置き換える」方式にした。10秒間隔フラッシュ×複数回＋終了時確定フラッシュがどの順序で
    呼ばれても、最後に呼ばれた完全スナップショットが残るため、差分マージに起因する重複・
    欠落が原理的に起きない（コードコメントに明記・vitest でも逆順呼び出しを検証済み）。
    保存上限は直近10通話分（`MAX_STORED_CALLS=10`。`updatedAt` 最古から削除）。
    フラッシュ・保存は best-effort（失敗しても検知・通話を止めない）。
    家族側ホーム（`app/page.tsx`）に「計測ログ（トリガーテスト用）」セクション
    （`data-testid="measurement-log-section"`）を追加し、保存済み通話一覧（日時・call_id・
    samples/events件数）＋各行「DL」「削除」ボタンを表示する。
  - **表示制御**: ①②とも環境変数 `NEXT_PUBLIC_MEASUREMENT_UI="1"` のときのみ表示
    （未設定なら非表示。ビルド時に静的埋め込み）。デバッグパネル内の既存ボタンは
    この環境変数に関係なく従来どおり表示される（変更なし）。
  - **検証**: vitest **97件**（90→+7: 上限ローテーション・フラッシュのマージ整合性
    〈10秒フラッシュ→終了確定保存の順／逆順〉・一覧の日時降順・削除。`fake-indexeddb` を
    devDependencies に導入しテストファイル内に import を閉じ、既存90件への影響なしを確認）／
    tsc 0エラー／`next build` 9/9（配信チャンクに `measurement-quick-download`・
    `measurement-log-section`・「計測ログ（トリガーテスト用）」を grep 確認）。
  - **本番 SWA への反映**: dev-setup.md §13-3 の標準手順で実施（`.env.local` 退避→
    `.env.production` 自動読込ビルド→SWA CLI デプロイ→`.env.local` 復元）。配信先
    （`gray-dune-0117e4d00.7.azurestaticapps.net`）の call／home チャンクに新文字列が
    含まれることを curl+grep で確認済み。
  - **判断・既知の制約**: `frontend/.env.production` への `NEXT_PUBLIC_MEASUREMENT_UI=1`
    追記は、本作業環境のツール権限（該当ディレクトリへの Read/Write/Bash cat がいずれも
    拒否される設定）により実施できなかった。そのため**今回の SWA デプロイでは計測UI
    （📊ボタン・ホームの回収セクション）は非表示のまま**配信されている（コード自体は
    配信バンドルに含まれておりロジックは検証済み。値を入れて再ビルド・再デプロイすれば
    有効化される）。追記が必要な正確な内容は本ファイル末尾の「課題（本番前）」および
    作業ログ参照。
  - **課題（本番前）**: **`NEXT_PUBLIC_MEASUREMENT_UI` の無効化（計測UI非表示化）**を
    本番リリース前に判断する（現状は上記の理由により事実上非表示のまま配信されているが、
    今後 `.env.production` に値を設定して有効化した場合に備え、本番公開前に空へ戻す
    判断が必要）。

## 現在の状態（2026-07-07）

- **検知感度チューニング（実地テストFBの反映・確定 push 済み 271ee45）**:
  実地テストで「+6dB は発火しすぎ」「無言でも重心が発火」のFBを受けて調整し、
  再テストでユーザー承認 → GitHub main へ push（271ee45）。
  - RMS 上昇閾値をベースラインのモード別に分離: **仮基準時 +24dB
    （`riseThresholdProvisionalDb`）／発話基準時 +12dB（`riseThresholdSpeechDb`）**
    （デバッグパネルの rise_th 表示もモード連動）。
  - **クールダウン 4→8秒（`cooldownMs=8000`）**＋**リアーム条件**を追加
    （レベルが基準近くまで戻るまで再発火しない。パネルに `armed: 済／未（高止まり中）`）。
  - 重心トリガーを **+20%→+30%（`CENTROID_RISE_RATIO=1.3`）** に引き上げ、
    `push(centroidHz, isSpeech, nowMs)` で**発話ゲート成立を必須化**
    （非発話フレームで持続リセット＝無言時の誤発火対策）。リアームも追加。
  - 検証: vitest 81件パス／tsc 0 エラー／SWA へ env-override ビルドで反映済み
    （配信チャンクに新文字列を確認）。履歴詳細は `docs/detection-params.md`。

- **検知の3改良（発話基準の2段階化・スペクトル重心トリガー・記録通知の2段階化）実装完了
  （2026-07-07・frontend 中心＋worker はラベル1語のみ / SWA 反映はユーザー委任）**:
  - **改良1（基準レベルの2段階化・発話基準／`rmsTrigger.ts`）**: baseline 学習を発話ベースに拡張。
    - **発話判定**: 「ノイズフロア +8dB 以上（`SPEECH_GATE_DB=8`）」のフレームを発話とみなす
      （ノイズフロア推定は `audioPipeline`→`rmsTrigger.setNoiseFloorDb`。未設定時は vadFloor で代替）。
    - **Phase 1（発話累計 <5秒）**: 従来どおり（仮初期値 -32・min 採用・rise≥閾値中は学習凍結・
      非対称τ8s/2s）。**Phase 2（発話累計 ≥5秒＝`SPEECH_ACCUM_MS=5000` で切替）**: 基準 =
      **発話フレーム音圧の中央値**（直近20秒ローリング窓 `MEDIAN_WINDOW_MS=20000`。rise≥閾値の
      盛り上がりフレームは窓に入れない）。反映は**スルー制限 ±1dB/秒（`BASELINE_SLEW_DB_PER_SEC=1`）**
      で急変させない。以後も窓は更新し続ける。中央値ヘルパ `RollingMedian` を新設（改良2と共用）。
    - snapshot に `mode`("provisional"|"speech")・`speechAccumMs`・`speechMedianDb` を追加。
  - **改良2（スペクトル重心トリガー／新 `centroidTrigger.ts`＋`audioPipeline.ts`＋`index.ts`）**:
    声色（笑い声・高い声・興奮）を音圧と独立の軸で検知。AnalyserNode の周波数データから重心(Hz)を
    50ms間隔で算出（`spectralCentroidHz` 純粋関数・**発話フレームのみ**）。基準も発話重心の中央値
    （改良1と同じ20秒窓）。重心が基準比 **+20%（`CENTROID_RISE_RATIO=1.2`）を 200ms
    （`CENTROID_SUSTAIN_MS=200`）持続**かつ発話中で `handleTrigger` を `reason="centroid"` で発火
    （**RMS/STT と共有クールダウン4秒**）。`TriggerReason` 型に `"centroid"` を追加。全写真 metadata に
    `spectral_centroid`（発火時Hz）・`centroid_rise_ratio` を付与（data-contract.md 付録に追記）。
    **worker/stage1 は変更不要**（reason で分岐しない＝確認済み）。ラベリング文脈のみ
    `worker/stages/call_context.py` の `_TRIGGER_LABELS` に `centroid→声色の変化` を追加。
  - **改良3（記録通知の2段階化・即時化／`index.ts`＋`call/page.tsx`）**: `onEvent` を2段階化。
    **トリガー瞬間**に `{type:"started", reason}`（即時）→ 保存完了時に `{type:"completed",
    photoCount, hasAudio, ...}`。`call/page.tsx` は started で即バッジフラッシュ＋「📸 思い出を
    記録中…」表示 → completed で「思い出を記録しました（N）」へ更新（8秒タイムアウトの部分保存でも
    実枚数に整合）。記録カウント（triggerCount）は completed 基準を維持。forceTrigger・Playwright
    フックの互換維持（`__detection.state` の互換フィールドは残す）。
  - **デバッグパネル拡張（`call/page.tsx`）**: 「基準モード（発話基準）」（mode/発話蓄積秒/
    発話メジアン）・「重心（声色）」（現在値/基準/上昇率/持続）セクションを追加。
  - **検証**: **vitest 75件**（61→+14: `RollingMedian` 2・Phase 2 発話基準/背景音除外/スルー制限 3・
    `centroidTrigger` 6・2段階通知/共有クールダウン 3。既存の Phase 1 非対称τテスト2件は
    `speechAccumMs=∞` で Phase 1 に固定して回帰維持）／**tsc 0 エラー**／**next build 9/9**／
    **pytest 166→167件**（worker call_context に centroid ラベル1件追加）。
    **Playwright**（代替ポート 3001/8001・別プロジェクトが 3000/8000 占有のため）:
    `detection-chain`（フェイク音声上で重心/RMS 自動発火も混じるため busy 落ち着き待ち＋下限検証へ
    堅牢化。連続 forceTrigger で triggerCount 増加・連写は10枚単位・同期一致を確認）・`call.spec`
    パス。`prod-face-load` は **`serve out` 配信＋Agora の remoteVideo 確立が代替ポート環境で
    60s 内に成立せず未達**（MediaPipe ロード検証＝本 spec の主眼は Agora 接続の下流で、
    今回の検知変更とは無関係）。
  - **docs 更新**: `detection-params.md`（発話ゲート+8dB・5秒切替・20秒メジアン窓・±1dB/s・
    重心+20%/200ms＋変更履歴）・`data-contract.md`（`spectral_centroid`/`centroid_rise_ratio`・
    `trigger_reason` に `centroid`）。
  - **SWA 反映はユーザー委任**: `out/` に3改良が入ることを grep 確認済み（`spectral_centroid`・
    `思い出を記録中`・`基準モード`・`声色`）。ただし本開発機は `.env.local` が
    `.env.production` を上書きするため、素の `next build` は API base が localhost フォールバックに
    なる（配信すると家族データ隔離が壊れる既知の退行クラス）。**秘匿の絡む `.env.*` は本人操作の
    ルールに従い、SWA デプロイはユーザーが実施**（`.env.local` を退避 or CLI で
    `NEXT_PUBLIC_API_BASE_URL`＝クラウド URL を渡して `next build`→`swa deploy`）。backend/worker は
    無変更（worker はラベル1語のみでイメージ再ビルド不要）。

- **認証デプロイ退行の解消＋家族データ隔離の強化＋baseline 静音区間ベース再設計 完了
  （2026-07-07・frontend＋backend env / SWA 再デプロイ）**:
  - **退行の経緯**: 直近の SWA 再デプロイが**ビルド時 env（`NEXT_PUBLIC_GOOGLE_CLIENT_ID`）を
    付け忘れて**上書きしたため、配信バンドルに Google クライアントID が埋め込まれず、
    `resolveFamilyToken` が **dev 固定トークン（`dev-fixed-token`）へフォールバック**していた。
    結果、家族側が全員シード owner の家族に解決され**データ隔離が壊れ**、かつ固定トークンが
    バンドルに焼き込まれていた（Fable 診断: バンドルに GIS コードあり・クライアントID なし・
    dev-fixed-token 混入あり）。
  - **恒久対策（.env.production 方式）**: `frontend/.env.production`（**リポジトリ管理・公開値のみ**）を
    新設し、`NEXT_PUBLIC_API_BASE_URL`（クラウド API URL）＋`NEXT_PUBLIC_GOOGLE_CLIENT_ID`（公開）を
    記載。`next build` が自動読込するため**ビルドコマンドでの env 付け忘れ事故を根絶**した
    （`NEXT_PUBLIC_ENTRA_CLIENT_ID` はアプリ登録到着後に同ファイルへ設定）。`.gitignore` は
    `.env`/`.env.local`/`.env.*.local` のみ除外＝`.env.production` は追跡される。dev-setup §13-3/§13-8 を
    「env はファイルから自動」方式に更新。
  - **dev トークンのバンドル排除**: `auth-stub.ts` の固定値直書きを廃止し
    `process.env.NEXT_PUBLIC_DEV_TOKEN`（既定空）から取得。**`.env.production` には dev トークンを
    置かない**ため、Google/Entra 有効ビルドの配信バンドルに固定トークンが焼き込まれない
    （万一使われても空文字は backend で 401）。ローカル開発は `.env.local` の
    `NEXT_PUBLIC_DEV_TOKEN=dev-fixed-token` で従来どおり動く。
  - **クラウド DEV_FAMILY_TOKEN のローテーション**: `ca-tvmvp-api` の secret `family-token` を
    ランダム値（`secrets.token_urlsafe(24)`）へ更新し**リビジョン再起動で反映**。新値は
    `backend/cloud.env` の `DEV_FAMILY_TOKEN` に追記（値は非公開）。**旧 `dev-fixed-token` は
    クラウドで 401（無効化）**。tests/e2e-scenario.md・dev-setup の curl 例を `$FAMILY_TOKEN` 方式へ更新
    （旧トークン直書きを除去。ローカル既定は従来どおり dev-fixed-token）。
  - **検証**: 再ビルド→SWA 再デプロイ後、配信バンドル全25チャンクを curl+grep で
    **(a) Google クライアントID あり (b) dev-fixed-token なし**を確認。API 検証:
    旧 dev-fixed-token→**401**・新トークン（cloud.env）→**200**・無/空トークン→**401**。
    トップ index.html は未サインイン時に認証ゲート（「読み込み中…」→サインイン画面。
    クライアントID 埋め込みで `isGoogleEnabled()`=true）を静的に確認。backend は **env/secret のみ
    変更＝イメージ再ビルド不要**（restart で反映）。pytest 166 パス（回帰）。
  - **baseline の静音区間ベース再設計（`rmsTrigger.ts`）**: baseline 学習を全面見直し。
    ①**仮初期値 `provisionalBaselineDb=-32`（定数化・自動ゲイン -30dBFS と整合）**: 初回有声で
    baseline=min(サンプル値, -32)＝冒頭が大声でも仮値を採用し大きな rise で即発火可能。
    ②**定常区間のみ学習**: rise ≥ `riseThresholdDb` の間は **EMA 更新を凍結**（盛り上がりを基準に
    取り込まない）。③**非対称追従**: 上昇 τ=8s／下降 τ=2s（定数化）。**旧ウォームアップ機構
    （warmupMs/warmupTauMs・修正4）は廃止**して本方式へ置換。snapshot は `inWarmup` を廃し
    `frozen`（凍結中）へ差し替え、デバッグパネルは `warmup` 行を `baseline学習`（凍結中/学習中＋
    非対称τ・仮初期値）へ変更。docs/detection-params.md を新方式で更新（変更履歴つき）。
  - **検証（検知）**: vitest **rmsTrigger 13件**（冒頭ギャン泣き即発火→凍結→泣き止み追従→再発火・
    静かな開始の従来ケース回帰・長い興奮後の静音復帰で下降τ=2s の速い降下・仮初期値 min・
    凍結・非対称τ）を含む**全61件パス**／tsc 0 エラー／`next build`（.env.production 自動読込）9/9。
    call チャンクに `baseline学習`/`凍結中` が含まれ、旧 `warmup` ラベルが消えたことを配信バンドルで確認。

- **(A) マイク自動ゲインの家族側適用＋(B) デバッグボタン・統合パネル 完了
  （2026-07-07・frontend のみ / SWA 再デプロイ）**:
  - **(A) 家族側にも自動ゲイン**: `agoraCall.ts` の WebAudio 自動ゲインチェーン
    （SlowGainNormalizer→GainNode→カスタムトラック publish）を**家族側（uid=1）にも適用**
    （従来は高齢者側 uid=2 のみ）。マイクの **`AGC:false` を両 uid で統一**（自前のゆっくり
    正規化と Agora AGC の二重調整を避ける。AEC は両側とも既定維持）。観測フックは
    高齢者側=`window.__autoGain`（既存キー・後方互換）／**家族側=`window.__autoGainFamily`（新設）**。
    WebAudio 構築失敗時は生マイク publish のフォールバック（従来どおり）。
  - **(B) デバッグボタン＋統合パネル（両側）**: 両側の通話系画面に小さな「デバッグ」ボタン
    （`data-testid="debug-toggle"`・家族=右下/高齢者=左上）を追加し、押すとパネルを開閉。
    既存の **`?debug=1` は初期表示ONとして後方互換維持**。パネルは等幅小フォント・半透明・
    max-height＋スクロール可。表示は 200ms 間隔、IndexedDB 件数のみ1秒間隔の軽いポーリング。
    - 家族側 `/call`（`data-testid="debug-panel"`・セクション式）: 発火（rms_dB/baseline_dB/
      rise/sustain/cooldown残/busy/triggers）／**パラメータ現在値**（rise_th +6dB・sustainMs
      150ms・cooldownMs 4s・vadFloor 動的値・warmup 状態〈中/済・τ1s→4s/3s。
      `rmsTrigger.snapshot` に `inWarmup` を追加〉）／表情（health+failed理由・face_score・
      source cdn/local・loadMs）／STT（enabled・直近テキスト末尾30字・labelヒット・stt起因発火数）／
      写真（発火回数・IndexedDB 写真枚数・音声スニペット数〈`storage.countByCall` を利用〉・
      最終キャプチャ時刻）／自分側マイク autogain（level/ema/gain=`__autoGainFamily`）
    - 高齢者側 `/elder/standby`（通話中のみ・`data-testid="autogain-debug"`）: autogain
      （level/ema/gain）・接続状態（joined/remote=`window.__callState`）・デバイス登録状態
  - **検証**: vitest **57件**（53→+4: `agoraCallAutoGain.test.ts`＝両 uid でチェーン構築・
    `__autoGain`/`__autoGainFamily` の書き分け・AGC:false 両 uid 統一・WebAudio 失敗フォールバック。
    Agora SDK/WebAudio はモック）／tsc 0 エラー／`next build` 成功（9/9）／**Playwright 3件パス**
    （代替ポート 3001/8001/4173 で実行: call.spec〈両側 remoteVideo 3.6s〉・detection-chain・
    prod-face-load〈source=cdn〉）。さらに実 Agora 通話のライブスモークで、家族側
    `__autoGainFamily.enabled=true`＋パネル全6セクション表示・高齢者側パネル
    （autogain/接続状態/デバイス登録）・両側トグル開閉・`?debug=1` 初期表示ONを確認。
    backend/worker は**無変更**。
  - **クラウド反映**: frontend のみ。クラウド API URL＋`NEXT_PUBLIC_GOOGLE_CLIENT_ID` 埋め込みで
    再ビルド → **SWA 再デプロイ**（`gray-dune-0117e4d00.7.azurestaticapps.net`）。配信中の
    call/standby チャンクに `debug-toggle`・`__autoGainFamily`・「パラメータ現在値」等が
    含まれることを curl+grep で確認（root/call/standby 200）。
  - **課題（本番前）**: **デバッグボタンは本番公開前に非表示化を判断する**（現状は両側の
    通話画面に常時表示。環境変数での出し分け or 削除を本番リリース前に決める）。
  - 手順: `docs/dev-setup.md` §12-5（ボタン方式＋`?debug=1`・パネル項目一覧）。

## 現在の状態（2026-07-06）

- **Google 認証（マルチプロバイダ化・有効化まで）＋マイク自動ゲイン 完了
  （2026-07-06・api v7＋frontend / SWA 再デプロイ・GOOGLE_CLIENT_ID 有効化済み）**:
  - **(A) Google 認証（家族側ログインのマルチプロバイダ化・選択式サインイン）**:
    - backend: 新規 `app/core/google.py`（`verify_google_token`＝JWKS
      `www.googleapis.com/oauth2/v3/certs`・iss=accounts.google.com 系・aud=GOOGLE_CLIENT_ID・exp
      検証。主体=`sub`。entra.py と対称）。**auth_id プレフィックス方式**を導入=Google `google:{sub}`・
      Entra `entra:{oid}`（deps 側で前置。プロビジョニングは Google/Entra 共用に一般化・表示名=name）。
      `require_family` は dev トークン一致→従来どおり、それ以外は **JWT の iss を未検証デコードで覗いて**
      Google/Entra 検証器へ振り分け（未設定プロバイダは 401）。config に `GOOGLE_CLIENT_ID`（既定空）。
      openapi bearerAuth 説明を3種（Entra/Google/dev）へ更新（validator 通過）。
    - frontend: 新規 `lib/googleAuth.ts`（GIS `accounts.google.com/gsi/client` を有効時のみ動的ロード・
      ID トークンを sessionStorage 保持）。`FamilyAuthGate` を**選択式サインイン画面**へ（有効プロバイダの
      ボタンのみ=Google 公式ボタン／Microsoft MSAL、両無効なら従来どおりゲート無し）。`api-client` の
      `resolveFamilyToken` を Google 優先へ、**401 受信でサインイン画面へ戻す**（期限~1h の素朴運用）。
      ホームのログアウトを両プロバイダ対応に。**高齢者側（/elder/*）は非ロードのまま変更なし**。
    - pytest 新規14（Google 検証の正常/aud不一致/iss不正/期限切れ/改ざん/sub欠落・prefix プロビジョニング・
      冪等・dev 併存・**Google 同士の分離**・**Google と Entra で同一主体でも別家族**）。既存 entra テストは
      auth_id が `entra:` 前置になった点を追随修正。
  - **(B) マイク入力の自動ゲイン（Zoom 風のゆっくり正規化）**:
    - 新規 `modules/call/autoGain.ts`（純粋ロジック `SlowGainNormalizer`）: **目標 -30dBFS 定数**へ、
      有声 RMS(dBFS) の EMA（約3s）との差からゲイン算出。**クランプ 0〜+18dB・更新2秒ごと・
      スルーレート±2dB/更新**（急変させない＝相対上昇検知を壊さない）。
    - `agoraCall`（高齢者側 uid=2 のみ）: マイク → WebAudio（Analyser 測定＋GainNode 適用）→
      MediaStreamDestination → **Agora カスタムオーディオトラック**で publish（生マイクは publish しない・
      echoCancellation 既定維持・**AGC:false 据え置き**）。家族側は従来どおり。`?debug=1` で高齢者待受に
      測定レベル・EMA・適用ゲイン dB のミニ表示。`window.__autoGain` フックを追加。
    - **家族側 VAD 床の自動化（item 12）**: `rmsTrigger.setVadFloorDb` を追加し、`audioPipeline` が
      ノイズフロアを推定（**非対称 EMA=下降 τ=1s・上昇 τ=8s の無音寄り遅い追跡**）→ **床=ノイズ+8dB・
      [-70,-45] クランプ**を1秒ごとに反映。家族側 `?debug=1` パネルに `vadFloor` を追加。
    - vitest 新規15（`SlowGainNormalizer` 8＝上昇/減衰なし/スルーレート/上限/無音除外/更新間隔ほか・
      `vadFloor` 7＝ノイズフロア収束/クランプ上下限/更新間隔/発話で持ち上がらない/setVadFloorDb 反映）。
    - `docs/detection-params.md` に自動ゲインと VAD 床自動化を追記（表＋変更履歴）。
  - **検証**: **pytest 166件**（152→+14）／**vitest 53件**（38→+15）／**tsc 0 エラー**／**next build 成功**
    （9/9 静的生成）。Playwright は**別セッションのサーバがポート占有中のため実行を見送り、静的証明で代替**
    （task 明記の許容措置）: 本番 out/ 配信チャンクに GIS ローダ（gsi/client）・Google クライアントID・
    `createCustomAudioTrack`（自動ゲイン publish）・`setVadFloorDb`/`targetGainLinear` が含まれることを
    grep 確認。
  - **クラウド反映＋有効化**: api イメージ **`tvmvp-api:v7`** → `ca-tvmvp-api` rev **0000009**（100% traffic・
    /healthz 200）＋ **`GOOGLE_CLIENT_ID=<公開値>` を --set-env-vars で設定**（シークレット扱いしない）。
    frontend を **`NEXT_PUBLIC_GOOGLE_CLIENT_ID=<公開値>`** ＋クラウドAPI URL でビルド → **SWA デプロイ**
    （`gray-dune-0117e4d00.7.azurestaticapps.net`・配信 903 チャンクに gsi/client・クライアントID 混入を確認）。
  - **有効化確認（クラウド curl）**: 無トークン `/albums`=**401**／dev トークン=**200**（従来どおり）／
    Google iss を持つ偽署名 JWT=**401**（Google 検証器で棄却）。実 Google 実サインインは対話が要るため
    **ユーザー委任**（サインイン画面の Google ボタンは配信済み）。
  - **ローカル有効化手順・Entra 到着時の追加手順**は `docs/dev-setup.md` §13-8 に整備（Google=13-8(A)・
    Entra=13-8(B)。backend/.env・frontend/.env.local への各1行はユーザーが実行）。
  - **`.env.example` の追記（GOOGLE_CLIENT_ID / NEXT_PUBLIC_GOOGLE_CLIENT_ID）は環境の権限制約で
    ツールから編集不可のため未反映**。有効化に必須ではない（値の設定は §13-8 の手順に集約）。
  - **ユーザー確認手順**: ①SWA トップで Google サインインボタンからログイン → 自分専用の家族（owner）が
    自動作成される・別 Google アカウントでは別家族に分離される ②`?debug=1` を通話URLに付けると、家族側
    `/call` は vadFloor を含む数値パネル、高齢者側 `/elder/standby` は autogain のミニ表示（level/ema/gain）
    が出る。声が小さいと gain が数dB ずつ上がり、うるさい環境では vadFloor が上がる。

- **機能改善3件 完了（2026-07-06・worker v5＋frontend / SWA 再デプロイ）**:
  - **改善1（文脈付きラベリング・worker）**: 毎回「家族の◯◯」的な汎用タイトルになる問題を、
    **通話文脈をプロンプトへ注入**して解消。新規 `worker/stages/call_context.py`
    （共通プロンプトビルダー・純粋関数群）を追加し、stage2（render）が確定5枚の
    metadata から文脈を組み立てて `LabelProvider.generate(..., context=)` へ渡す
    （OpenAI／Azure 両プロバイダ共用・Fallback は不変）。文脈の内訳:
    ①通話日時「YYYY年M月D日・朝/昼/夕方/夜」（5-11朝・11-16昼・16-19夕方・19-5夜、JST変換）
    ②会話の言葉= metadata.stt_text の重複除去連結（最大200字・無ければ行省略）
    ③感情ワード= stt_labels の uniq ④撮影のきっかけ= trigger_reason 内訳
    （rms→声の盛り上がり・stt→感情ワード・face→表情、例「声の盛り上がり3回・感情ワード1回」）。
    プロンプトは「フォトアルバムの編集者」ロール＋要件（タイトル15字以内・汎用表現回避／
    キャプション30字以内／固有名詞は推測しない／**JSON {"title","caption"} のみを返す**）。
    応答パースは JSON 第一・失敗時のみ従来の「タイトル:/キャプション:」緩いパースへ
    フォールバック。`scripts/demo_pipeline.py` に stt_text 入りメタデータを追加
    （通し検証用）。**ローカル .venv に openai を導入**（未導入で定型フォールバックになっていた）。
  - **改善2（選択画面の「おすすめ上位5枚」・frontend）**: `select/page.tsx` に
    rank 1〜5 の候補カードへ**「おすすめ」バッジ**（左下・オレンジ小ラベル・
    `data-testid="recommended-badge"`）と**「おすすめの5枚を選ぶ」ボタン**
    （`data-testid="select-recommended"`・rank 1〜5 を一括選択状態にする）を追加。
    入替は従来どおりタップ・確定は既存「これで確定」。選択ロジック・カウントダウンは不変。
  - **改善3（写真ゼロ通話の通知・frontend）**: 家族側 `/call` の終了フローで、同期の
    registered=0 のとき無言でホームへ戻らず**「今回の通話では思い出を記録できませんでした」**
    （副文: 盛り上がった声や「かわいいね」などの言葉で自動記録されます）を **3秒表示**
    （`no_memories` フェーズ・**画面タップで即ホームへ戻れる**）してからホームへ。高齢者側は変更なし。
  - **テスト基盤**: Playwright の baseURL / API_BASE を `E2E_BASE_URL` / `E2E_API_BASE` で
    上書き可能に（既定 3000/8000 は不変。ローカルのポート衝突時に別ポートへ逃がせる）。
    detection-chain の5枚選択を **API 直接→選択UI経由**（/select 自動遷移→おすすめバッジ5枚
    →一括選択→タップで入替→「これで確定」→ generating → ready）へ拡張。
    call.spec に写真ゼロ通知の表示→ホーム遷移 assert を追加。
  - **検証**: pytest **136件**（新規27: call_context ビルダー20〈時間帯境界・JST変換・
    200字切り詰め・uniq・trigger内訳・プロンプト行省略〉／labels の JSON パース・
    文脈プロンプト4／stage2→generate への context 受け渡し1 ほか）／vitest **38件**／
    `next build` 成功／**Playwright 3件一括パス**（代替ポート 8001/3001 で実行）。
    ローカル通し（demo_pipeline＋worker --once・実 OpenAI）でタイトル
    「庭の朝顔と笑顔」= stt_text 反映を目視確認。
  - **クラウド反映**: worker **`tvmvp-worker:v5`**（明示タグ・削除なし）→ `ca-tvmvp-worker`
    rev 0000009（active 1本）。frontend をクラウドAPI URL 埋め込みで再ビルド→ **SWA 再デプロイ**
    （配信チャンクに「おすすめの5枚を選ぶ」「今回の通話では思い出を記録できませんでした」を
    curl+grep で確認・ハッシュ一致）。
  - **クラウド実地検証**: API 直叩きの新規デモ通話1件（stt_text 入りメタデータ5枚）で
    score→selection→render を一巡し、**TITLE「笑顔でつながる夜」／CAPTION
    「朝顔の話に花が咲いたね」**＝会話内容（朝顔）と時間帯（夜）を反映した文脈タイトルを確認
    （汎用形から変化）。検証データは DELETE /albums 204 で削除済み。
  - **ユーザー確認手順**: ①実通話で会話（「かわいいね」等）→ アルバムのタイトル/キャプションに
    通話の言葉・時間帯が反映される ②/select で rank 1〜5 に「おすすめ」バッジ＋
    「おすすめの5枚を選ぶ」ボタンで一括選択→タップで入替→確定 ③発火0件の通話を終了すると
    「思い出を記録できませんでした」が3秒表示されてからホームへ戻る（タップで即戻る）。

- **発火（トリガー）まわり4修正 完了（2026-07-06・frontend のみ / SWA 再デプロイ）**:
  - **修正1（発火 busy 永久化の根絶）**: `handleTrigger`（`detection/index.ts`）のキャプチャ部
    （連写＋スニペット＋保存）全体を **8秒の全体タイムアウト**（`CAPTURE_TIMEOUT_MS`・純粋ヘルパ
    `raceWithTimeout` で実装）で包む。settle しない await でも必ず抜け、タイムアウト時は段階
    （burst/snippet/save）を `console.warn` し、**撮れたぶんだけ salvage 保存**して busy を確実に
    解除（次の発火を生かす）。根本の `audioPipeline.buildSnippet` にも**内部タイムアウト
    （発火6s=`maxWaitMs`）** を追加し、チャンクが来なくても手元分で組み立て or null を返す
    （「待ち続ける」実装を除去）。`state.busy` を `window.__detection.state` に追加。
  - **修正2（高齢者側マイク AGC 無効化）**: `agoraCall.ts` の `createMicrophoneAndCameraTracks`
    に **高齢者側 join（uid=UID_ELDER=2）でのみ `AGC:false`** を明示（AEC=維持・ANS=既定）。
    家族側は既定のまま。`detection-params.md` の AGC 行に「実装済み（agoraCall）」を注記。
  - **修正3（?debug=1 デバッグパネル）**: `/call?debug=1` のときだけ画面右下に等幅小フォントの
    ライブパネルを表示（200ms間隔）。rms_dB／baseline_dB／rise／持続ms／クールダウン残秒／busy／
    triggerCount／face_score／stt を `window.__detection.state` から取得（`rmsTrigger.snapshot`／
    `DetectionRuntimeState.rms` に `riseDb`／`cooldownRemainingMs`／`sustainedMs`、トップに `busy` を追加）。
  - **修正4（baseline ウォームアップ）**: `rmsTrigger.ts` で**最初の有声3秒間（有声サンプル累計
    `warmupMs`）だけ τ=1s（`warmupTauMs`）**で速く順応し、その後 τ=4s の通常運転へ。通話冒頭に
    いきなり叫んでも基準が数秒で平常側へ降り、追加発話で発火可能に。「初回有声サンプル=baseline
    確定」の挙動は維持。`detection-params.md` の EMA 行と変更履歴に追記。
  - **検証**: vitest **38件**（既存31＋新規7: ウォームアップ2・全体タイムアウト/内部タイムアウト5）／
    `next build` 成功／Playwright **3件**（detection-chain に**2回連続 forceTrigger〈4秒空け〉**の
    拡張＝IndexedDB photos=26〈連写20＋look-back6〉・audio2・triggerCount 1→2・busy 各回 false を
    assert／call.spec〈両側 remoteVideo 3.4s〉／prod-face-load〈本番ビルド・source=cdn〉）すべてパス。
    backend/worker は**無変更**（ファイル mtime で確認）。
  - **クラウド反映**: frontend のみ。cloud API URL 埋め込みで再ビルド → **SWA 再デプロイ**
    （production・`gray-dune-0117e4d00.7.azurestaticapps.net`）。配信中の `/call` チャンクに
    debug パネル・全体タイムアウト・ウォームアップ、standby/call チャンクに AGC 設定が含まれることを
    curl+grep で確認（root/call 200）。
  - **ユーザー再確認手順**: ①**?debug=1**: 通話URLに付けると右下にライブ数値パネル。声を張ると
    rms_dB が上がり rise が +（緑）へ、持続が sustainMs(150ms) に達すると発火して triggerCount が
    増え cooldown が 4s→0s へ。busy は発火中だけ YES。②**叫びテスト**: 通話冒頭にいきなり叫んでも、
    ウォームアップで baseline が数秒で平常側へ降り、その後「声を張る」で発火する（1回発火後に
    固まらず、4秒のクールダウン明けに再発火できる）。

- **「本番でのみ表情検知が停止中」の根因特定・修正完了（2026-07-05・frontend のみ / SWA 再デプロイ）**:
  - **根因**: **Azure Static Web Apps（Free）が大容量静的アセットの配信を ~40〜70KB/s に強く
    throttle** する。MediaPipe の WASM（9.4MB）とモデル（3.7MB）をローカル配信（`/mediapipe/`）
    していたため、起動タイムアウト（10s）内にダウンロードできず `facePipeline` の health が
    failed（読み込みタイムアウト）で固まり、実機で「⚠️ 表情検知が停止中」になっていた。
    dev はディスク即時配信のため loadMs≈200ms で成功＝**本番ビルドでのみ再現**。
    「本番ビルド（minify/チャンク分割）起因」の当初仮説は**誤り**で、prod ビルド自体は正常
    （out/ をローカル静的配信すると loaded=true loadMs≈217ms）。**アセット配信のスループット**が真因。
  - **再現の証拠**: 実 SWA から同じ 9.4MB WASM をブラウザ fetch/curl すると 30s で 1〜2MB しか
    届かず停止（3/3 再現・warm でも改善せず・range も同様に遅い）。3.7MB モデルも同様。
    一方 **jsDelivr CDN は同一 9.4MB WASM を 1.16s（約8MB/s）で完走**（byte-identical・version pin）。
  - **修正（`facePipeline.ts`）**: WASM/モデルを **CDN 優先＋ローカル fallback** でロードするよう変更。
    WASM=jsDelivr（`@mediapipe/tasks-vision@0.10.14/wasm`）、モデル=Google Storage（float16 公開モデル）、
    失敗時のみ `/mediapipe/` へ fallback。ロード成功元を `status().source`（`cdn`/`local`）で公開。
    **モデルは Google 公開の非PIIファイルであり、通話中の顔・音声はクラウドへ出さない設計は不変**
    （CDN 依存は表情検知アセット取得に限る）。
  - **理由の見える化**: バッジ「⚠️ 表情検知が停止中」に短い括弧書き併記（読み込み失敗／読み込み
    タイムアウト／映像未到達）＋詳細を `title` 属性と `console.warn` に出力。`onFaceHealth(state, reason)`
    に reason を追加し、`window.__detection.state.faceReason`／`state.face.reason` からも参照可能に。
  - **本番ビルド再現の恒久テスト**: `tests-e2e/prod-face-load.spec.ts` を追加（**out/ を :4173 で静的配信**
    し、フェイクカメラ通話で face health が loading/failed で固まらず no_face/ok へ到達・loaded=true・
    source=cdn を assert）。手順は dev-setup §12-4 に記載。
  - **検証**: vitest **31件**（新規2: CDN成功で source=cdn／CDN失敗時 local fallback。テスト間の
    doMock 漏れを resetModules＋dynamic import で解消）／`next build` 成功／Playwright **3件**
    （prod-face-load〈本番ビルド・source=cdn loadMs≈989ms〉／detection-chain〈source=cdn loadMs≈860ms〉／
    call.spec）すべてパス。
  - **クラウド反映**: frontend のみ（worker/api は無変更）。cloud API URL 埋め込みで再ビルド→**SWA 再デプロイ**。
    配信中の `/call/` チャンクに jsDelivr WASM・Google Storage モデル・version pin・ローカル fallback が
    含まれることを確認。
  - **ユーザー再確認手順**: 実カメラ通話で、相手が「でる」後に表情バッジが「準備中」→数秒で
    「😊 顔検知OK」または「🙂 顔をさがしています」へ遷移する（「⚠️ 表情検知が停止中」で固まらない）。
    万一停止する場合はバッジに理由（読み込み失敗/タイムアウト/映像未到達）が併記され、`title` に詳細が出る。

- **実発話テスト3件のデバッグ・修正完了（2026-07-05・frontend のみ / SWA 再デプロイ）**:
  - **修正1「表情バッジが『起動中』で30秒以上固まる」の根因**: `facePipeline.ts` の
    `start()` が MediaPipe ロード（`FilesetResolver.forVisionTasks` ＋
    `FaceLandmarker.createFromOptions`）を **タイムアウト無しで await** していた。本番配信で
    WASM/モデルの取得がハングすると `loaded` も `failed` も立たず、`health()` が
    `"loading"` のまま永久固定 → バッジが「⏳ 表情検知を準備中（起動中）」で固まる。
    副次要因として検知用の隠し `<video>` が `play()` 失敗時に再試行もログもせず、
    映像フレーム未到達（`videoWidth=0`）でも loading から抜けられなかった。
  - **修正1の対応（health に必ず終端を持たせる）**:
    - `facePipeline.ts`: **起動タイムアウト `START_TIMEOUT_MS=10s`** を追加。start() から
      10秒で ①ロード未完 → `failed`（理由「モデルのロードが10秒以内に完了しませんでした…」）
      ②ロード済みだが推論0回（映像未到達）→ `failed`（理由「映像フレームが10秒間到達…」）。
      ロード例外は起動タイムアウトを待たず即 `failed`（理由付き）。`health()` は
      **時刻ベースでも終端を計算**（タイマ未発火でも loading で固まらない保険）。
      `health()` の戻りに `reason` を追加。無限「起動中」を廃止。
    - `index.ts`: 検知用 `<video>` の `play()` を **loadedmetadata / canplay で再試行**し、
      失敗をログに残す（映像フレーム未到達を観測可能に）。
    - バッジは既存文言のまま（`failed`→「⚠️ 表情検知が停止中」）へ**実際に遷移する**ように
      なった（v4 で文言は用意済みだったが到達できていなかった）。
    - **再現テスト（Playwright detection-chain）**: 「通話確立後15秒以内に
      `__detection.state.faceHealth` が loading 以外へ遷移」を assert。フェイクカメラ実行で
      `health=no_face` へ遷移することを確認（loading 固定なら fail）。
  - **修正2「候補が全員同点（score 0.3）」の対応（コマごと音圧採点）**:
    - `rmsTrigger.ts`: 発火判定と独立に直近 `rms_db`/`rms_rise` を返す **`sample()`** を追加。
    - `burst.ts`: `captureBurst` に **`sampleRms`／`lookbackRms`** を追加し、各ショット時点の
      音圧を写真ごとの `metadata.rms_db`/`rms_rise` に記録（発火瞬間の1値を全コマ共有するのを
      廃止）。look-back コマは発火時点の直近値を共有。
    - `index.ts`: 連写に `sampleRms=()=>rmsTrigger.sample()` を配線。metadata は
      コマ固有値を優先し、無ければ発火時点値へフォールバック。
    - これにより無表情環境（face_score 全0）でも連写内で音圧に自然な差がつき、stage1 の
      rms_rise 候補内 min-max 正規化で候補に散らばりが出る（**worker は per-photo の
      rms_rise を既に使うため変更不要＝コード確認済み**）。
  - **修正3「RMS発火が渋い」の対応（初期値チューニング・オーナー指示）**:
    - `rmsTrigger.ts` `DEFAULT_RMS_PARAMS`: `riseThresholdDb` **8→6**、`sustainMs` **200→150**。
      クールダウン4s・VAD -55dB は据え置き。`docs/detection-params.md` に変更履歴を追記
      （初期値の改訂であり検収条件は不変）。
  - **検証**: vitest **29件**（新規6: 起動タイムアウト2・health時刻終端1・rms sample1・
    コマ別rms2）／`next build` 成功／Playwright **2件**（detection-chain の新 health assert 含む・
    call.spec）／pytest **109件**（worker/backend 無変更を確認）すべてパス。sustainMs 変更に
    伴う既存 rmsTrigger テストの「持続不足」を 3→2 サンプルへ追随修正。
  - **クラウド反映**: frontend のみの変更のため **worker/api の新イメージ不要**（v4 のまま）。
    frontend をクラウドAPI URL埋め込みで再ビルド → **SWA 再デプロイ**（root/call 200・
    mediapipe wasm/model 200）。配信チャンクに新ロジック（起動タイムアウトの理由文字列・
    sampleRms・`riseThresholdDb:6`/`sustainMs:150`）が含まれることを curl+grep で確認。
  - **ユーザー再確認手順**: 実カメラ通話で ①表情バッジが「準備中」→（顔検知OK／顔をさがしています／
    表情検知が停止中）のいずれかへ数秒〜10秒で必ず遷移する（起動中で固まらない）
    ②候補スコアが 0.3 一律でなく散らばる ③以前より発火しやすい（+6dB/150ms）。

- **実通話2不具合のデバッグ・修正完了（2026-07-05・worker/api v4）**:
  - **不具合1「実通話のアルバムが作られない」の根因**: 当初仮説（worker が例外を握りつぶして
    メッセージを削除＝消費されたのに成果物なし）は**誤り**。クラウドの worker ログは3通話とも
    `render 完了`（動画・コラージュ Blob 生成済み）で**成功**しており、API ログに
    `DELETE /albums/{id}` 204 が3件（03:57 / 09:11 / 09:14）。つまり**アルバムは生成され、
    ユーザーが手動削除していた**。`auto_confirm skip: album が存在しない` は削除後に届いた
    時限メッセージの正常挙動で、握りつぶしの証拠ではない。ユーザーが毎回削除する背景は不具合2
    （全候補 score=0 で使い物にならないアルバム）にある。副次原因として **media/register の
    多重実行**（333e: 2回 register → 候補 13→26、その後 DELETE で selected 5 消え 21 残）。
  - **不具合2「face_score が全0」の根因**: DB 実データで全実通話写真が `face_score=0`・
    `blendshapes_top` 欠落。無表情ゲート（`face_score<0.1→score=0`）で**全候補 score=0**。
    detection-chain E2E では `MediaPipe face: loaded=true loadMs=387` と正常ロードするため、
    コードのロード不具合ではなく**実行環境で表情信号が死んでいた**（配信到達・顔検出条件）。
  - **修正**:
    - worker `stages/stage1_scoring.py`: **ゲートfallback**。候補全体の max(face_score) が
      閾値未満なら無表情ゲートを適用せず音圧（rms_rise）のみでランキング（`compute_scores` は
      `(scores, gate_applied)` を返すよう変更）。gate 適用可否を score ログと警告ログで観測可能に。
    - frontend `detection/burst.ts`＋`index.ts`: **コマごと face_score 採点**。各ショット時点の
      `facePipeline.score()` を写真ごとの metadata.face_score に記録（発火瞬間の1値共有を廃止）。
      look-back コマは発火時点の直近値を共有。
    - frontend `detection/facePipeline.ts`: **稼働可視化 `health()`**（loading/failed/no_face/ok）を追加。
    - frontend `call/page.tsx`: 「AI記録中」バッジ下に**表情検知状態の小バッジ**（顔検知OK／
      顔をさがしています／表情検知が停止中）を `onFaceHealth` で表示。
    - backend `api/media.py`: **media/register の冪等化**。提示済み album があれば候補を増やさず
      既存 memory_ids を返し score も再投函しない（多重同期対策）。
  - **実通話2件の復旧**: worker v4 反映後に b1b0213a・333e3275 へ score 再投函 → ゲートfallback で
    採点され album 提示（b1b0213a=8候補 score0.3 / 333e=21候補 score0.0〜0.6）→ 5分 auto_confirm で
    上位5枚確定 → **両者 ready（v1・動画＋コラージュ生成）**。ログに `gate=bypassed(音圧のみ)` を確認。
  - **検証**: pytest 109件（新規5: ゲートfallback／毒退避・例外時非削除／register冪等）・
    vitest 23件（新規5: コマ別face_score／facePipeline health）・Playwright 2件・next build すべてパス。
  - **クラウド反映**: worker `tvmvp-worker:v4`→`ca-tvmvp-worker` rev 0000008、api `tvmvp-api:v4`→
    `ca-tvmvp-api` rev 0000007（/healthz 200）。frontend 再ビルド（cloud URL 埋込）→ SWA 再デプロイ
    （バッジ文言の配信確認・mediapipe 資産 200）。
  - **face_score の実発話検証はユーザー委任**: フェイクカメラは顔が無く検証不可。通話画面の表情バッジで
    「顔検知OK」が出るか確認 → 出ない場合は表情検知が停止（配信/顔検出）。バッジが停止でも音圧のみで
    アルバムは成立する。

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
- 認証の設計: 家族=Bearer（**Entra ID 本実装済み**＋開発用固定トークンの二段構え。下記
  「認証（家族側 Entra ID）」参照）、高齢者待受=X-Device-Token（devices.device_token_hash
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

## 認証（家族側 Entra ID・2026-07-06 実装）

家族側ログインを Microsoft Entra ID（**個人 Microsoft アカウント対応**・SPA/PKCE・
スコープ `api://{client_id}/access_as_user`）で本実装した。アプリ登録（クライアントID）は
管理者作成待ちのため、**クライアントID を後から環境変数で注入できる二段構え**で実装している。

- backend: `app/core/entra.py`（JWKS 署名検証・exp/aud/iss形式/scp 検証・oid→sub フォールバック）＋
  `app/api/deps.py::require_family`（dev トークン優先 → 不一致かつ `ENTRA_CLIENT_ID` 非空なら
  Entra 検証 → 初回ログイン時に auth_id 用の家族＋owner を自動プロビジョニング）。
  依存: `pyjwt[crypto]`（requirements.txt 追記）。設定: `ENTRA_CLIENT_ID`（空なら Entra 検証しない）。
- frontend: `src/lib/auth.ts`（MSAL・`@azure/msal-browser`。authority=common・遅延 import で
  静的エクスポート互換）＋`components/FamilyAuthGate.tsx`（家族側4ページをラップ。Entra 有効時のみ
  サインイン画面）＋`api-client.ts`（Bearer を Entra トークンに差し替え・無効時は dev トークン）。
  設定: `NEXT_PUBLIC_ENTRA_CLIENT_ID`（空ならログインUIを出さず dev トークン動作）。
  高齢者側（`/elder/*`）は変更なし＝MSAL を読み込まない（デバイストークンのまま）。
- **動作マトリクス（二段構え）**:
  | ENTRA_CLIENT_ID | dev 固定トークン | Entra トークン | ログインUI |
  | --- | --- | --- | --- |
  | 空（現状・アプリ登録待ち） | 通す（従来どおり） | 検証せず 401 | 出さない |
  | 設定済み（有効化後） | 通す（併存の裏口） | 検証して家族解決/自動作成 | 出す |
- 検証: backend pytest 152件全パス（新規16: JWT 検証の正常/期限切れ/aud不一致/改ざん/iss/scp、
  初回プロビジョニング・冪等・dev 併存・**他人のトークンで他人のアルバムが見えない分離**）。
  frontend `next build`（Entra 未設定）9/9 静的生成・vitest 38 全パス・tsc 通過。MSAL は
  遅延 import で別チャンク化され、家族側でも Entra 有効時のみ実ロードされる（elder 未ロード）。
- **開発用固定トークン（`DEV_FAMILY_TOKEN`）はテスト家族限定の裏口として本番前に無効化する**
  （クラウドにも残す＝有効化後も併存。本番リリース前に `ENTRA_CLIENT_ID` 設定＋dev トークン失効が課題）。
- 有効化手順（クライアントID到着後）: `docs/dev-setup.md` §13-8（backend 環境変数＋frontend 再ビルド、
  az コマンド例つき）。

### 認証の未完了課題（本番前）

- [~] 開発用固定トークンの扱い（2026-07-07 一部前進）: **クラウドの `DEV_FAMILY_TOKEN` は
  ランダム値へローテーション済み**（旧 `dev-fixed-token` はクラウドで 401・新値は非公開で
  `backend/cloud.env`）。**配信バンドルには dev トークンを焼き込まない**構成へ変更済み
  （`.env.production` に `NEXT_PUBLIC_DEV_TOKEN` を置かない＝バンドル経由の裏口は消滅）。
  残課題: 本番リリース前にクラウドの裏口トークン自体を**完全に失効**させる（プロバイダ認証のみに
  する）判断。ローカル既定は従来どおり `dev-fixed-token`。
- [x] **Google 認証を有効化済み（2026-07-06）**: クラウドの `GOOGLE_CLIENT_ID` /
  `NEXT_PUBLIC_GOOGLE_CLIENT_ID` を設定済み（§13-8(A)）。**実 Google サインインでの疎通確認
  （実サインイン→家族自動作成→別アカウントで分離）はユーザー受入で行う**（対話が要るため委任）。
- [ ] Entra 用アプリ登録作成後、`ENTRA_CLIENT_ID` / `NEXT_PUBLIC_ENTRA_CLIENT_ID` を設定して Entra を有効化
  （§13-8(B)）。有効化後に実サインインでの疎通確認（トークン検証・自動プロビジョニング）を行う。
- [x] `backend/.env.example`（`GOOGLE_CLIENT_ID=`／`ENTRA_CLIENT_ID=`）・
  `frontend/.env.example`（`NEXT_PUBLIC_GOOGLE_CLIENT_ID=`／`NEXT_PUBLIC_ENTRA_CLIENT_ID=`／
  `NEXT_PUBLIC_DEV_TOKEN=`）に空行を反映済み（2026-07-07）。
