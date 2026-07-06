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

## 現在の状態（2026-07-07）

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

- [ ] 本番リリース前に開発用固定トークン（`DEV_FAMILY_TOKEN` / `dev-fixed-token`）を無効化する
  （テスト家族限定の裏口。有効化後もクラウドに残しているため、本番前に必ず失効させること）。
- [x] **Google 認証を有効化済み（2026-07-06）**: クラウドの `GOOGLE_CLIENT_ID` /
  `NEXT_PUBLIC_GOOGLE_CLIENT_ID` を設定済み（§13-8(A)）。**実 Google サインインでの疎通確認
  （実サインイン→家族自動作成→別アカウントで分離）はユーザー受入で行う**（対話が要るため委任）。
- [ ] Entra 用アプリ登録作成後、`ENTRA_CLIENT_ID` / `NEXT_PUBLIC_ENTRA_CLIENT_ID` を設定して Entra を有効化
  （§13-8(B)）。有効化後に実サインインでの疎通確認（トークン検証・自動プロビジョニング）を行う。
- [ ] `backend/.env.example` / `frontend/.env.example` に `GOOGLE_CLIENT_ID`（空）/
  `NEXT_PUBLIC_GOOGLE_CLIENT_ID`（空）の行を追記する（環境の権限制約でツールから編集できず未反映）。
