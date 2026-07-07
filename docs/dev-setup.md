# ローカル開発環境セットアップ

backend（FastAPI）をローカルで動かすための手順。コマンドはコピペでそのまま実行できる。

## 前提

- Docker（Compose v2 以上）
- Python 3.11
- [uv](https://github.com/astral-sh/uv)（依存管理）

DB は postgres コンテナ、Blob/Queue は Azurite（Azure Storage エミュレータ）で代替する。
Agora は M1 以降、`backend/.env` にクレデンシャル（§3）を設定すると実トークン発行
（Real プロバイダ）になる。未設定なら Fake 実装で発行する（通話以外の開発は
アカウント不要のまま可能）。Azure Speech STT も同様で、`backend/.env` に
`AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`（§13-7）を設定すると実トークン発行（Real）＝
感情ワード検知が有効になる。未設定なら Fake（STT 無効・通話と RMS検知は継続する best-effort）。

## 1. 依存サービスの起動（postgres + azurite）

リポジトリ直下で:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP
docker compose up -d
```

- postgres: ホスト `localhost:5433`（DB名 `tvmvp` / ユーザー `tvmvp` / パスワード `tvmvp_dev_password`）
- azurite: Blob `localhost:10000` / Queue `localhost:10001`

状態確認:

```bash
docker compose ps
```

## 2. Python 仮想環境と依存導入

```bash
cd backend
uv venv --python 3.11
uv pip install -r requirements.txt
```

以降のコマンドは仮想環境を有効化して実行する:

```bash
source .venv/bin/activate
```

## 3. 環境変数（.env）

`backend/.env` はローカル専用値で用意済み（コミット禁止）。
新規に作る場合は `.env.example` をコピーして値を埋める:

```bash
cp .env.example .env
# DATABASE_URL / AZURE_STORAGE_CONNECTION_STRING / DEV_FAMILY_TOKEN を設定
```

ローカルの既定値:

| キー | 値 |
| --- | --- |
| `DATABASE_URL` | `postgresql://tvmvp:tvmvp_dev_password@localhost:5433/tvmvp` |
| `AZURE_STORAGE_CONNECTION_STRING` | Azurite の well-known 接続文字列 |
| `MEDIA_CONTAINER` | `media` |
| `QUEUE_NAME` | `pipeline-jobs` |
| `DEV_FAMILY_TOKEN` | `dev-fixed-token` |
| `FRONTEND_BASE_URL` | `http://localhost:3000` |
| `AGORA_APP_ID` | Agora Console の App ID（公開値。M1〜） |
| `AGORA_APP_CERTIFICATE` | Agora の Primary Certificate（**秘密値**。M1〜） |

Agora の2キーは**両方が非空のとき Real プロバイダ**（実トークン発行）、どちらか欠けると
Fake プロバイダに自動フォールバックする（`app/api/deps.py` の `get_agora_provider`）。
`AGORA_APP_CERTIFICATE` は秘密値であり、`.env` 以外（コード・ログ・ドキュメント）へ
絶対に書かないこと。

## 4. マイグレーション（テーブル・ENUM・インデックス作成）

alembic は環境変数 `DATABASE_URL` を読む（env.py の実装）。この1変数だけを渡す
（`.env` 全体を `source` すると接続文字列中の記号でうまく展開されないため、必要な変数のみ export する）:

```bash
cd backend
source .venv/bin/activate
export DATABASE_URL=postgresql://tvmvp:tvmvp_dev_password@localhost:5433/tvmvp
alembic upgrade head
```

適用結果の確認（psql をコンテナ経由で実行）:

```bash
# テーブル一覧
docker exec -i tvmvp-postgres psql -U tvmvp -d tvmvp -c '\dt'
# ENUM 一覧
docker exec -i tvmvp-postgres psql -U tvmvp -d tvmvp -c '\dT+'
# インデックス一覧
docker exec -i tvmvp-postgres psql -U tvmvp -d tvmvp -c \
  "SELECT indexname FROM pg_indexes WHERE schemaname='public' ORDER BY 1;"
```

## 5. シード投入（家族・owner・active デバイス）

seed.py と uvicorn は pydantic-settings が `backend/.env` を直接読むため、`source` は不要:

```bash
cd backend
source .venv/bin/activate
python scripts/seed.py
```

冪等（再実行しても重複しない）。標準出力に家族側 Bearer トークンと
デバイストークン（`dev-device-token`）が表示される。
デバイスのトークンハッシュは再実行のたびに既知値へリセットされるため、
`/devices/register` の手動確認でトークンが変わっても seed 再実行で復旧できる。

## 6. サーバ起動

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

（uvicorn も pydantic-settings 経由で `.env` を読むため `source` は不要。）

- Swagger UI: http://localhost:8000/docs
- ヘルスチェック: http://localhost:8000/healthz

## 7. テスト

テストは専用DB `tvmvp_test` を使う。初回のみ作成する:

```bash
docker exec -i tvmvp-postgres psql -U tvmvp -d tvmvp -c "CREATE DATABASE tvmvp_test;"
```

実行:

```bash
cd backend
source .venv/bin/activate
pytest -q
```

接続先を変えたい場合は `TEST_DATABASE_URL` を指定する:

```bash
TEST_DATABASE_URL=postgresql://tvmvp:tvmvp_dev_password@localhost:5433/tvmvp_test pytest -q
```

## 8. 手動スモーク（curl）

サーバ起動中に別ターミナルで実行する。`jq` があると読みやすい。

```bash
BASE=http://localhost:8000
FAMILY="Authorization: Bearer dev-fixed-token"
DEVICE="X-Device-Token: dev-device-token"

# seed 済みの device_id を取得（psql から）
DEVICE_ID=$(docker exec -i tvmvp-postgres psql -U tvmvp -d tvmvp -tAc \
  "SELECT id FROM devices WHERE status='active' LIMIT 1;")

# 発信
CALL=$(curl -s -X POST "$BASE/calls" -H "$FAMILY" -H 'Content-Type: application/json' \
  -d "{\"device_id\":\"$DEVICE_ID\"}")
CALL_ID=$(echo "$CALL" | jq -r .id)

# 着信ポーリング → 応答
curl -s "$BASE/calls/incoming" -H "$DEVICE"
curl -s -X POST "$BASE/calls/$CALL_ID/answer" -H "$DEVICE"

# アップロードSAS
curl -s -X POST "$BASE/media/upload-sas" -H "$FAMILY" -H 'Content-Type: application/json' \
  -d "{\"call_id\":\"$CALL_ID\",\"filenames\":[\"candidates/a.jpg\"]}"

# メディア登録（score ジョブが Azurite キューへ投函される）
curl -s -X POST "$BASE/media/register" -H "$FAMILY" -H 'Content-Type: application/json' \
  -d "{\"call_id\":\"$CALL_ID\",\"items\":[{\"type\":\"photo\",\"storage_key\":\"families/x/calls/$CALL_ID/candidates/a.jpg\",\"captured_at\":\"2026-07-03T00:00:00Z\"}]}"

# 候補取得（worker 未実装のため album 未作成 → 404 が正しい挙動）
curl -s -o /dev/null -w "candidates: %{http_code}\n" "$BASE/calls/$CALL_ID/candidates" -H "$FAMILY"

# 家族のアルバム一覧（空）
curl -s "$BASE/albums" -H "$FAMILY"
```

## 9. worker の起動（通話後パイプライン）

worker は backend の SQLAlchemy モデル・設定を再利用するため、**backend/.venv の python**
で実行する（`worker/bootstrap.py` が `backend/` を `sys.path` に追加する）。
設定（`DATABASE_URL`・`AZURE_STORAGE_CONNECTION_STRING` 等）は backend と同じく
pydantic-settings が `.env` から読む。**cwd を `backend/` にして起動する**
（`env_file=".env"` は cwd 相対のため）。FFmpeg（`ffmpeg` / `ffprobe`）が必要。

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/backend

# 常駐ポーリング（キューが空なら2秒待ち。Ctrl-C で停止）
.venv/bin/python ../worker/main.py

# キューが空になるまで処理して終了（テスト・デモ用）
.venv/bin/python ../worker/main.py --once
```

job_type ごとの処理:

- `score`: 候補スコアリング（無表情ゲート付き）→ album 提示 → auto_confirm を可視化遅延300秒で投函
- `auto_confirm`: 5分無選択なら上位5枚で自動確定 → generating → render 投函
- `render`: 選択5枚から FFmpeg でハイライト動画を生成 → Blob 保存 → ready

auto_confirm の遅延はデモ・テスト用に短縮できる（既定300秒）:

```bash
AUTO_CONFIRM_DELAY_SECONDS=5 .venv/bin/python ../worker/main.py --once
```

### 9-1. タイトル/キャプション生成プロバイダ（LABEL_PROVIDER）

render 時のタイトル・キャプション生成は `worker/stages/labels.py` の
`get_label_provider` が選ぶ。優先順位:

1. **`LABEL_PROVIDER` 環境変数による明示指定**: `openai`（直 OpenAI API）／
   `azure`（Azure OpenAI）／`fallback`（定型）。指定先の必須環境変数が
   欠けている場合や不正値の場合は、警告ログを出して定型フォールバックになる
2. **未指定なら自動判定**: `OPENAI_API_KEY` があれば **openai を優先**
   （MVP 期間中の暫定方針。乖離の記録は CLAUDE.md「確定済み設計からの乖離」）
   → 無ければ `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` /
   `AZURE_OPENAI_DEPLOYMENT` が揃っていれば azure → どちらも無ければ fallback

ローカルで直 OpenAI 版を使う手順（キーは支給されたものをユーザーが設定する。
リポジトリ・コミットには絶対に含めない）:

```bash
# backend/.env に1行追記するだけ（worker/main.py が起動時に .env を os.environ へ
# 読み込むため、ワーカーが自動で拾う。モデルを変える場合は OPENAI_MODEL も追記）
echo 'OPENAI_API_KEY=<支給されたキー>' >> backend/.env

# ワーカーを起動（§9 と同じ）
cd backend && .venv/bin/python ../worker/main.py --once
```

- モデルは `OPENAI_MODEL`（省略時 `gpt-4o-mini`）
- 生成を止めたいとき（コスト節約・オフライン作業）は `LABEL_PROVIDER=fallback`
- クラウド（ca-tvmvp-worker）への設定は §13-6 を参照

## 10. デモパイプラインの実行（統合検証）

`scripts/demo_pipeline.py` が、ダミー画像生成 → API 登録 → worker → 候補提示 → 選択 →
render → ffprobe 検証（duration≈30秒・h264/aac）まで通す。手動選択経路と自動確定経路の
両方を検証する。

前提: 上記 1〜6 が済み、**backend サーバが起動中**であること（別ターミナルで uvicorn）。

```bash
# ターミナルA: サーバ起動（8000）
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/backend
source .venv/bin/activate
uvicorn app.main:app --port 8000

# ターミナルB: デモ実行（cwd を backend/ にして .env を読ませる）
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/backend
.venv/bin/python ../scripts/demo_pipeline.py
```

- worker は demo スクリプトが `--once` で内部起動するため、別途起動は不要。
- 別 URL のサーバを使う場合は `DEMO_BASE_URL=http://... .venv/bin/python ../scripts/demo_pipeline.py`。
- ダミー画像は番号入り JPEG をシステム python3 の Pillow で生成する（`drawtext` 非搭載の
  FFmpeg でも動くようにするため）。Pillow が無い環境では FFmpeg 単色画像へフォールバックする。

## 11. 疑似E2E通し手順（UIを含む一巡）

RFP 12章（検収条件）の判定手順は `tests/e2e-scenario.md`（支給物A9）が正。
本節はローカルでそれを一巡するための起動順のみをまとめる（詳細は各§参照）。

1. §1〜5 を実施する（docker compose → 依存導入 → .env → マイグレーション → seed）。
   （2026-07-05 更新: 発信の device_id はサーバ自動解決になったため、
   `NEXT_PUBLIC_DEFAULT_DEVICE_ID` の設定は**不要**。既に `.env.local` にあっても参照されない。）
2. §6 で backend を起動する（uvicorn @8000）。
3. frontend を起動する（@3000）:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/frontend
npm install   # 初回のみ
npm run dev
```

4. `tests/e2e-scenario.md` のステップ1〜7を順に実施する。
   - 通話（コア①）は M1 で実装済み（Agora 実接続）。検知（コア②）のみダミー代替で、
     候補投入は §10 の `demo_pipeline.py`
     （UI で選択確定まで確認する場合は、e2e-scenario.md ステップ4の個別手順で
     score 投函までにとどめ、§9 の `worker --once` を挟みながら進める）。
   - 家族側と高齢者側は別ブラウザ/別プロファイルの Chrome を使うと
     localStorage（device_token）が分離されて実運用に近い。

## 12. 自動テスト（ユニット＋Playwright・M1/M2）

### 12-1. 検知ロジックのユニットテスト（vitest・M2）

RMS発火判定の純粋ロジック（`frontend/src/modules/detection/rmsTrigger.ts`）を検証する。
テスト本体は `frontend/tests-unit/rmsTrigger.test.ts`、設定は `frontend/vitest.config.ts`。
docker/uvicorn 等は不要（DOM/WebAudio に依存しない純粋ロジックのみ）。

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/frontend
npm install          # 初回のみ（vitest を含む）
npm run test:unit    # vitest run（発火する系列・持続不足・クールダウン・無音でbaseline不動）
```

### 12-2. 自動通話テスト（Playwright・M1）

家族⇔高齢者の Agora 実通話（相互の映像受信・通話終了の伝搬）を自動検証する。
テスト本体は `frontend/tests-e2e/call.spec.ts`、設定は `frontend/playwright.config.ts`。

前提: §1〜6 と §11-3 が済んでいること（docker compose・uvicorn@8000・next dev@3000 稼働中、
`backend/.env` に Agora 実クレデンシャル設定済み）。**Agora の実ネットワークに接続する**
（無料枠 1万分/月を消費する。1回の実行は数十秒程度）。

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/frontend
npm install                        # 初回のみ（@playwright/test を含む）
npx playwright install chromium    # 初回のみ（テスト用ブラウザの取得）
npm run test:e2e                   # tests-e2e/ の全 spec（M1 通話＋M2 フルチェーン）
# 個別実行例:
npx playwright test call.spec.ts             # M1 通話のみ
npx playwright test detection-chain.spec.ts  # M2 フルチェーンのみ
```

- Chromium は偽カメラ/マイク（`--use-fake-device-for-media-stream`
  `--use-fake-ui-for-media-stream`）で起動する（許可ダイアログなし・実カメラ不要）。
- テストが内部で `backend/scripts/seed.py` を実行するため、デバイストークンは
  既知値（`dev-device-token`）にリセットされる。実ブラウザで登録済みの待受ページが
  あるとそのトークンは無効になる（復旧は再登録 or そのブラウザで localStorage を
  `dev-device-token` に設定）。
- M1 判定: 両コンテキストで `window.__callState.remoteVideo === true`（相手ストリーム受信）
  → 家族の「通話を終了する」で高齢者が待受へ自動復帰、まで確認する（fake 音声は発火しない
  ため家族はホームへ戻る）。

### 12-3. 検知フルチェーンE2E（Playwright・M2）

通話 → 検知発火（`window.__detection.forceTrigger()`）→ IndexedDB キャプチャ →
通話終了で同期 → memories 作成 → worker score → candidates → 5枚選択 → worker render →
album ready までを1本で自動判定する。テスト本体は
`frontend/tests-e2e/detection-chain.spec.ts`。

- テストが内部で `backend/scripts/set_blob_cors.py` を実行し、Azurite に CORS を設定する
  （ブラウザ直 PUT のため必須。本番=Azure では A1 の担当）。
- テストが `backend/.venv/bin/python worker/main.py --once` を child_process で2回
  （score / render）実行する（`backend/.venv` に依存導入済みであること）。
- 観測: IndexedDB photos=連写10＋look-back・audio=1 / 同期 registeredMemories /
  candidates 件数 / album status=ready。

**注意**: `next dev` 稼働中に `next build` を実行しないこと。`.next/` を共有しているため
dev サーバのアセット提供が壊れ、ページの JS が 404 になる（症状: 待受ページが
ポーリングを開始しない等）。壊れた場合は `next dev` を再起動する。

### 12-4. 本番ビルドでの表情検知ロード回帰テスト（Playwright・2026-07-05）

**目的**: dev（`next dev`）ではなく **本番ビルド（`next build` の `out/` 静的成果物）** で、
表情検知（MediaPipe FaceLandmarker）のアセットがロードでき、face health が loading/failed で
固まらず no_face/ok へ到達することを assert する。テスト本体は
`frontend/tests-e2e/prod-face-load.spec.ts`。

> **なぜ dev では気づけなかったか**: dev はアセットをディスクから即時配信するため常に成功する。
> 本番（Azure SWA Free）は 9.4MB の WASM・3.7MB のモデルの配信を強く throttle するため、
> 当初のローカル配信（`/mediapipe/`）では起動タイムアウト（10s）内に届かず「表情検知が停止中」に
> なった。修正で CDN 優先（jsDelivr／Google Storage）＋ローカル fallback に変更済み。
> この回帰テストは **本番ビルドを別ポートで配信**して検証する（dev と本番の差分を突く）。

`next dev`（:3000）を**止めてから**、別ターミナルで本番ビルドを静的配信する:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/frontend

# 1) 本番ビルド（out/ に生成。API はローカル backend を指す）
NEXT_PUBLIC_API_BASE_URL="http://localhost:8000" npx next build

# 2) out/ を静的配信（:4173）。serve は .wasm を application/wasm で返す（SWA 相当）
npx --yes serve out -l 4173 --no-clipboard
```

backend（uvicorn）は **CORS に `http://localhost:4173` を追加**して起動する（本番配信オリジンの
模擬。ローカル repro 専用。既定の localhost:3000 は自動で維持される）:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/backend
CORS_ALLOW_ORIGINS="http://localhost:3000,http://localhost:4173" \
  .venv/bin/uvicorn app.main:app --port 8000
```

この状態で回帰テストを実行する:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/frontend
npx playwright test tests-e2e/prod-face-load.spec.ts
```

- 観測ログ: `本番ビルド face: loaded=true failed=false loadMs=<ms> source=cdn health=no_face`。
  `source` はロード成功元（`cdn`＝本命／`local`＝CDN 不可時の fallback）。
- assert: face health が loading/failed で固まらず `no_face`/`ok` へ到達・`loaded=true`。

### 12-5. 通話画面のデバッグパネル（ボタン方式＋?debug=1・2026-07-07）

両側の通話系画面に、右下（家族側）/左上（高齢者側）の小さな**「デバッグ」ボタン**
（`data-testid="debug-toggle"`）があり、押すと統合デバッグパネルを開閉できる。
従来どおり **URL に `?debug=1` を付けると初期表示ON**（後方互換）。表示値は 200ms 間隔、
IndexedDB 件数のみ1秒間隔の軽いポーリング。パネルは等幅小フォント・半透明・スクロール可。

- **家族側 `/call`**（`data-testid="debug-panel"`）: セクション別に表示する。
  - 発火: rms_dB / baseline_dB / rise / sustain / cooldown残 / busy / triggers
  - パラメータ現在値: rise_th(+6dB) / sustainMs(150ms) / cooldownMs(4s) /
    vadFloor（動的値） / warmup 状態（中/済・τ1s→4s/3s）
  - 表情: health（ok/no_face/failed+理由） / face_score / source(cdn/local) / loadMs
  - STT: enabled / 直近テキスト（末尾30字） / labelヒット / stt起因発火数
  - 写真（この通話）: 発火回数 / IndexedDB 保存写真枚数 / 音声スニペット数 / 最終キャプチャ時刻
  - 自分側マイク autogain: level / ema / gain（`window.__autoGainFamily`）
- **高齢者側 `/elder/standby`（通話中のみ）**（`data-testid="autogain-debug"`）:
  autogain（level/ema/gain＝`window.__autoGain`）・接続状態（joined/remote＝
  `window.__callState`）・デバイス登録状態
- 注意: デバッグボタンは MVP 検証用。**本番公開前に非表示化を判断する**（CLAUDE.md の課題参照）。

## 13. クラウド環境（Azure・A1）

A1 で Azure 東日本に本番相当の環境を構築済み（リソース一覧・URL・月額は `infra/README.md`）。
リソースグループは `rg-001-gen12`、命名サフィックスは `73bb`。接続情報・秘密は
`backend/cloud.env`（`.gitignore` 済み・コミット禁止）に集約している。

### 13-1. 構成の全体像

- `ca-tvmvp-api`（FastAPI・外部Ingress:8000）← ブラウザ/フロントから叩く API
- `ca-tvmvp-worker`（通話後パイプライン・Ingressなし・**KEDA でキューが空なら0レプリカ**）
- `psql-tvmvp-73bb`（PostgreSQL 16）／`sttvmvp73bb`（Blob=media・Queue=pipeline-jobs）
- `swa-tvmvp-73bb`（Static Web Apps・Free）← frontend の静的エクスポートを配信
- `oai-tvmvp-73bb`（Azure OpenAI・`gpt-4o` Regional Standard）← worker のタイトル/キャプション生成
- `acrtvmvp73bb`（Container Registry・Basic）← backend/worker のイメージ置き場

秘密はコンテナのシークレットに格納（DB接続・Storage接続・OpenAIキー）。cloud.env はローカルから
DB マイグレーション/seed/検証を行うための控え。

### 13-2. backend / worker の更新（イメージ再ビルド → コンテナ更新）

コードを変えたら ACR でクラウドビルドし、Container App を新イメージへ更新する
（ローカルに Docker 不要。ビルドコンテキストはリポジトリ直下、`.dockerignore` で軽量化済み）。

> **タグ運用（2026-07-05〜の標準）**: イメージタグは `v2`, `v3`, … の**明示バージョン
> （イミュータブル）**で作成し、既存タグ（`latest` 含む）は上書きしない
> （事故時に直前タグへ即ロールバックできるようにするため）。

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP

# API を更新する場合（<vN> は現行タグ +1。現行は az acr repository show-tags で確認）
az acr build --registry acrtvmvp73bb --image tvmvp-api:<vN> --file backend/Dockerfile .
az containerapp update -g rg-001-gen12 -n ca-tvmvp-api \
  --image acrtvmvp73bb.azurecr.io/tvmvp-api:<vN>

# worker を更新する場合（ffmpeg＋BGM 入りイメージ。BGM は worker/assets/bgm/ を同梱）
az acr build --registry acrtvmvp73bb --image tvmvp-worker:<vN> --file worker/Dockerfile .
az containerapp update -g rg-001-gen12 -n ca-tvmvp-worker \
  --image acrtvmvp73bb.azurecr.io/tvmvp-worker:<vN>
# （旧運用の latest タグ時代は「新リビジョンが立たない」対策で digest 指定していたが、
#   明示バージョンタグならタグ変更で必ず新リビジョンが立つため不要）
```

> worker は 1080p のクロスフェード合成でメモリを食うため **1.0 CPU / 2.0 GiB** で構成している
> （1 GiB では ffmpeg が OOM=SIGKILL する）。

DB スキーマを変えたときは、ローカルから cloud DB に対して alembic を流す（§4 と同じ要領。
接続先だけ cloud.env の DATABASE_URL に差し替える）:

```bash
cd backend
set -a; source cloud.env; set +a
export DATABASE_URL
.venv/bin/alembic upgrade head
```

### 13-3. frontend（SWA）の再デプロイ

frontend は静的エクスポート（`next.config.mjs` の `output:'export'`）→ SWA CLI で配信する
（GitHub 連携なし・デプロイトークン方式）。**`next dev` を止めてから**ビルドすること
（`.next/` 共有問題を避けるため、別ディレクトリにコピーしてビルドしてもよい）。

**ビルド時の env は `frontend/.env.production` から自動読込する（2026-07-07・退行対策）**。
`next build`（本番）は `.env.production` を自動で読み込むため、`NEXT_PUBLIC_*` を
**コマンドラインで手渡す必要はない**。以前はビルドコマンドに `NEXT_PUBLIC_GOOGLE_CLIENT_ID` を
付け忘れると Google クライアントID が埋め込まれず、配信バンドルが dev トークンへフォールバック
して家族データの隔離が壊れる退行が起きた。**公開値は `.env.production`（リポジトリ管理）に
書き、付け忘れ事故を根絶する**。秘匿値・dev トークンは `.env.production` に**絶対に書かない**。

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/frontend

# env はファイル（.env.production）から自動読込される。手渡し不要。
npx next build      # out/ に生成される（.env.production の NEXT_PUBLIC_* が埋め込まれる）

# デプロイトークンを取得して SWA CLI で配信
TOKEN=$(az staticwebapp secrets list -g rg-001-gen12 -n swa-tvmvp-73bb \
  --query properties.apiKey -o tsv)
npx --yes @azure/static-web-apps-cli deploy ./out \
  --deployment-token "$TOKEN" --env production
```

> `.env.production` の現在値: `NEXT_PUBLIC_API_BASE_URL`（クラウド API URL）＋
> `NEXT_PUBLIC_GOOGLE_CLIENT_ID`（公開・Google 有効化）。`NEXT_PUBLIC_ENTRA_CLIENT_ID` は
> アプリ登録到着後に値を入れて再ビルドする（空の間は Microsoft ボタンを出さない）。
> `.gitignore` は `.env` / `.env.local` / `.env.*.local` のみ除外するため `.env.production` は
> 追跡される（公開値のみを置く前提）。

新しい SWA URL になった場合は、API 側の CORS / FRONTEND_BASE_URL と Storage CORS も更新する:

```bash
SWA_URL="https://<new-host>.azurestaticapps.net"
az containerapp update -g rg-001-gen12 -n ca-tvmvp-api \
  --set-env-vars "CORS_ALLOW_ORIGINS=http://localhost:3000,$SWA_URL" "FRONTEND_BASE_URL=$SWA_URL"
STCONN=$(az storage account show-connection-string -g rg-001-gen12 -n sttvmvp73bb \
  --query connectionString -o tsv)
az storage cors clear --services b --connection-string "$STCONN"
az storage cors add --services b --methods GET PUT OPTIONS HEAD \
  --origins "http://localhost:3000" "$SWA_URL" \
  --allowed-headers "*" --exposed-headers "*" --max-age 3600 --connection-string "$STCONN"
```

### 13-4. Agora シークレットの設定（ユーザーが実施）

A1 では Agora の秘密を扱っていない。お手元の `backend/.env` の `AGORA_APP_ID` /
`AGORA_APP_CERTIFICATE` を API コンテナに設定すると、クラウドでも実トークン発行（通話）が有効になる。
コマンドは最終報告のプレースホルダー版を参照（`<APP_ID>` / `<APP_CERTIFICATE>` を差し替える）。

### 13-5. cloud.env について

`backend/cloud.env` は A1 が生成した秘密・接続情報の控え（`.gitignore` 済み）。
DB パスワード・DATABASE_URL・Storage 接続文字列・seed 出力の ID・OpenAI エンドポイントを含む。
**OpenAI の API キーは cloud.env に書かず、worker のシークレット `openai-key` に格納**している
（`openai-key`=Azure OpenAI 用。直 OpenAI 用の支給キーは §13-6 の `openai-api-key`）。
このファイルは絶対にコミットしない。

### 13-6. 直 OpenAI キーの設定（ユーザーが実施・MVP 暫定）

支給された OpenAI API キーを `ca-tvmvp-worker` にシークレットとして設定すると、
クラウドのタイトル/キャプション生成が直 OpenAI API（`gpt-4o-mini`）になる
（選択の優先順位は §9-1。乖離の記録は CLAUDE.md「確定済み設計からの乖離」）。
`<OPENAI_API_KEY>` を差し替えて実行する:

```bash
# 1) シークレット登録
az containerapp secret set -g rg-001-gen12 -n ca-tvmvp-worker \
  --secrets openai-api-key=<OPENAI_API_KEY>

# 2) 環境変数をシークレット参照で設定（明示指定で openai に固定）
az containerapp update -g rg-001-gen12 -n ca-tvmvp-worker \
  --set-env-vars "OPENAI_API_KEY=secretref:openai-api-key" "LABEL_PROVIDER=openai"
```

> worker は KEDA（azure-queue）で min0 のため revision の再起動は不要。
> 次回キュー投入でスケール 0→1 に起床したときに新しい環境変数が反映される。

本番前の切り戻し（Azure OpenAI Regional へ戻す。AZURE_OPENAI_* は A1 設定済み）:

```bash
az containerapp update -g rg-001-gen12 -n ca-tvmvp-worker \
  --set-env-vars "LABEL_PROVIDER=azure"
```

### 13-7. Azure Speech STT の設定（削減ラダー②解除・2026-07-05）

Azure Speech リソース `speech-tvmvp-73bb`（F0・japaneast）を作成済み。キー/region は
`backend/cloud.env` の `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`（`.gitignore` 済み・コミット禁止）。

**クラウド（`ca-tvmvp-api`）は設定済み**（secret `speech-key`＋環境変数）。設定コマンドの控え:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/backend
SPEECH_KEY="$(grep '^AZURE_SPEECH_KEY=' cloud.env | sed -E 's/^AZURE_SPEECH_KEY="?([^"]*)"?$/\1/')"
SPEECH_REGION="$(grep '^AZURE_SPEECH_REGION=' cloud.env | sed -E 's/^AZURE_SPEECH_REGION="?([^"]*)"?$/\1/')"
az containerapp secret set -g rg-001-gen12 -n ca-tvmvp-api --secrets speech-key="$SPEECH_KEY"
az containerapp update -g rg-001-gen12 -n ca-tvmvp-api \
  --set-env-vars "AZURE_SPEECH_KEY=secretref:speech-key" "AZURE_SPEECH_REGION=$SPEECH_REGION"
# backend 変更のため api イメージ再ビルド → 更新（§13-2 と同じ）
```

**ローカルで STT を有効化する**には、`backend/.env` に Speech 設定を追記する（cloud.env の値を
そのまま流用・値は表示せず追記する）:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/backend
grep -E '^AZURE_SPEECH_(KEY|REGION)=' cloud.env >> .env   # 値を表示せず .env に追記
# uvicorn を再起動すると /tokens/speech が Real トークン（約10分の JWT）を返す
```

> フロント（`AzureSttProvider`）は `/tokens/speech` から短命トークンを取得し約9分ごとに更新する。
> Fake トークン（未設定時）では SDK 接続が認証失敗するが best-effort で STT 無効のまま継続する
> （通話・RMS検知に影響なし）。Playwright はこの Fake トークン経路で走る。

### 13-8. 家族側ログインの有効化（マルチプロバイダ・選択式サインイン）

家族側ログインは **Google アカウント** と **Microsoft Entra ID**（個人 Microsoft アカウント）の
2 プロバイダに対応し、**有効なプロバイダのボタンだけを出す選択式サインイン画面**になる。
どちらのクライアントID も後から環境変数で注入する多段構えのため、**どちらか一方だけの有効化**も、
**両方の有効化**も、**どちらも無効（dev トークン運用）** も選べる。

- backend の振り分け: dev トークン一致は従来どおり。それ以外は JWT の iss を未検証デコードで覗き、
  Google（iss=accounts.google.com 系）→ `GOOGLE_CLIENT_ID` で検証（auth_id=`google:{sub}`）、
  それ以外 → `ENTRA_CLIENT_ID` で検証（auth_id=`entra:{oid}`）。未設定プロバイダは 401。
- どちらのクライアントID も空なら、ログイン UI は出ず dev トークンのみで動作する
  （既存の pytest / Playwright / デモは無変更で通る）。

**(A) Google の有効化（クライアントID発行済み）**

Google Cloud コンソールの「OAuth 2.0 クライアント ID（ウェブ アプリケーション）」で、
承認済みの JavaScript 生成元に各環境のオリジン（`http://localhost:3000` と SWA の URL）を登録する
（GIS は生成元でトークン発行を制御する。クライアントシークレットは使わない＝ID トークンのみ）。

発行済みクライアントID（公開値）:
`1079731061136-b4qeaf52n55ukqhop8ft3khg6pmf67a2.apps.googleusercontent.com`

backend（`GOOGLE_CLIENT_ID` を設定して再起動。ローカルは backend/.env に1行）:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/backend
echo 'GOOGLE_CLIENT_ID=1079731061136-b4qeaf52n55ukqhop8ft3khg6pmf67a2.apps.googleusercontent.com' >> .env
.venv/bin/uvicorn app.main:app --reload --port 8000
```

クラウド（`ca-tvmvp-api`。**シークレットではないので --set-env-vars 直指定でよい**・イメージ再ビルド不要）:

```bash
az containerapp update -g rg-001-gen12 -n ca-tvmvp-api \
  --set-env-vars "GOOGLE_CLIENT_ID=1079731061136-b4qeaf52n55ukqhop8ft3khg6pmf67a2.apps.googleusercontent.com"
```

frontend（`NEXT_PUBLIC_GOOGLE_CLIENT_ID` はビルド時に静的に埋め込まれる。**2026-07-07 以降は
`frontend/.env.production` に公開値として記載済み**なので、ビルドコマンドで手渡す必要はない。
ローカルは frontend/.env.local に1行）:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/frontend

# NEXT_PUBLIC_GOOGLE_CLIENT_ID / NEXT_PUBLIC_API_BASE_URL は .env.production から自動読込。
npx next build

TOKEN=$(az staticwebapp secrets list -g rg-001-gen12 -n swa-tvmvp-73bb \
  --query properties.apiKey -o tsv)
npx --yes @azure/static-web-apps-cli deploy ./out \
  --deployment-token "$TOKEN" --env production
```

ローカルで Google を有効化して動かす場合（backend/.env と frontend/.env.local に各1行。ユーザーが実行）:

```bash
echo 'GOOGLE_CLIENT_ID=1079731061136-b4qeaf52n55ukqhop8ft3khg6pmf67a2.apps.googleusercontent.com' >> backend/.env
echo 'NEXT_PUBLIC_GOOGLE_CLIENT_ID=1079731061136-b4qeaf52n55ukqhop8ft3khg6pmf67a2.apps.googleusercontent.com' >> frontend/.env.local
```

確認:
- frontend を開くと家族側にサインイン画面が出て、**Google の公式サインインボタン**が表示される。
  ボタンからサインインすると ID トークンが sessionStorage に保持され、以降の API 呼び出しは
  その Bearer で通る。別 Google アカウントでサインインすると別家族に分離される。
- 無トークンの API 呼び出しは 401。
- **クラウドの dev トークンはローテーション済み（2026-07-07）**: 旧 `dev-fixed-token` は
  クラウド ca-tvmvp-api で **401**（無効化）。現在の裏口トークンは `backend/cloud.env` の
  `DEV_FAMILY_TOKEN`（ランダム値・非公開）。配信バンドルには dev トークンを焼き込まない
  （`.env.production` に `NEXT_PUBLIC_DEV_TOKEN` を書かない）ため、バンドル経由の裏口は無い。
  ローカル開発は従来どおり `dev-fixed-token`（backend/.env の `DEV_FAMILY_TOKEN`・
  frontend/.env.local の `NEXT_PUBLIC_DEV_TOKEN`）で可。
- 無効化に戻すには両環境変数を空にして配信し直す
  （例: `az containerapp update -g rg-001-gen12 -n ca-tvmvp-api --set-env-vars "GOOGLE_CLIENT_ID="`）。

**(B) Entra ID（家族側ログイン）の有効化（クライアントID到着後・2026-07-06）**

家族側ログインは Entra ID 本実装済み（個人 Microsoft アカウント対応・SPA/PKCE）。
ただしアプリ登録の作成は管理者待ちのため、**クライアントID を後から環境変数で注入する
二段構え**にしてある。

- 未設定（現状）: backend `ENTRA_CLIENT_ID` 空・frontend `NEXT_PUBLIC_ENTRA_CLIENT_ID` 空。
  → ログイン UI は出ず、家族側は開発用固定トークン（`DEV_FAMILY_TOKEN`）のみで動作する
  （既存の pytest / Playwright / デモは無変更で通る）。
- 設定後（有効化）: 家族側は「Microsoft でサインイン」画面 → ログインして利用。
  初回ログイン時にその auth_id 用の家族＋owner ユーザーが自動作成される。
  開発用固定トークンは併存（テスト家族限定の裏口。本番前に無効化する）。

前提: 管理者が Entra でアプリ登録を作成し、次を満たすこと。
- サインインできるアカウントの種類 = **個人 Microsoft アカウントを含む任意の組織ディレクトリ**
  （`AzureADandPersonalMicrosoftAccount`）。
- プラットフォーム = **SPA（PKCE）**。リダイレクト URI に各環境のオリジンを登録:
  `http://localhost:3000`（ローカル）と SWA の URL（本番）。
- 「API の公開」で **アプリ ID URI = `api://<CLIENT_ID>`**、スコープ **`access_as_user`** を追加。
  そのスコープをこの SPA クライアント自身に事前同意（Authorized client applications）しておく。

到着したクライアントID（アプリケーション（クライアント）ID）を `CLIENT_ID` として使う。

**(1) backend を有効化（`ENTRA_CLIENT_ID` を設定して再起動）**

ローカル:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/backend
echo 'ENTRA_CLIENT_ID=<CLIENT_ID>' >> .env   # 値を注入（クライアントIDは公開値）
# uvicorn を再起動すると、dev トークン以外の Bearer を Entra トークンとして検証する
.venv/bin/uvicorn app.main:app --reload --port 8000
```

クラウド（`ca-tvmvp-api`。イメージ再ビルドは不要＝環境変数のみ更新）:

```bash
az containerapp update -g rg-001-gen12 -n ca-tvmvp-api \
  --set-env-vars "ENTRA_CLIENT_ID=<CLIENT_ID>"
```

**(2) frontend を有効化（`NEXT_PUBLIC_ENTRA_CLIENT_ID` を埋め込んでビルド → SWA へ配信）**

`NEXT_PUBLIC_*` はビルド時に静的に埋め込まれるため、**設定して `next build` し直す**必要がある
（§13-3 と同じ配信手順。API URL も併せて埋め込む）:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/frontend

# NEXT_PUBLIC_ENTRA_CLIENT_ID は frontend/.env.production の該当行に <CLIENT_ID> を設定してから
# ビルドする（公開値・ファイル読込方式）。API URL も .env.production から自動読込される。
npx next build      # out/ に生成される

TOKEN=$(az staticwebapp secrets list -g rg-001-gen12 -n swa-tvmvp-73bb \
  --query properties.apiKey -o tsv)
npx --yes @azure/static-web-apps-cli deploy ./out \
  --deployment-token "$TOKEN" --env production
```

ローカルで有効化して動かす場合は `frontend/.env.local` に1行追記して `npm run dev`:

```bash
echo 'NEXT_PUBLIC_ENTRA_CLIENT_ID=<CLIENT_ID>' >> frontend/.env.local
```

> 本番（SWA）は `.env.local` ではなく `.env.production` を読む。到着した `<CLIENT_ID>` を
> `frontend/.env.production` の `NEXT_PUBLIC_ENTRA_CLIENT_ID=` 行に設定して再ビルド・配信する。

**(3) 確認**

- frontend を開くと家族側は「Microsoft でサインイン」画面になる。サインイン後、ホームに
  ユーザー名とログアウトが表示される。以降の API 呼び出しは Entra アクセストークンで通る。
- 開発用固定トークン（`dev-fixed-token`）も引き続き 200 を返す（併存の裏口）。
- 無効化に戻すには、両環境変数を空にして（backend は再起動、frontend は再ビルド）配信し直す。

> 無効化（切り戻し）例（クラウド backend）:
> `az containerapp update -g rg-001-gen12 -n ca-tvmvp-api --set-env-vars "ENTRA_CLIENT_ID="`

## 停止・クリーンアップ

```bash
# コンテナ停止（データは volume に残る）
docker compose down

# volume ごと破棄（DB・Azurite のデータを消す）
docker compose down -v
```
