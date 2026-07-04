# ローカル開発環境セットアップ

backend（FastAPI）をローカルで動かすための手順。コマンドはコピペでそのまま実行できる。

## 前提

- Docker（Compose v2 以上）
- Python 3.11
- [uv](https://github.com/astral-sh/uv)（依存管理）

DB は postgres コンテナ、Blob/Queue は Azurite（Azure Storage エミュレータ）で代替する。
Agora は M1 以降、`backend/.env` にクレデンシャル（§3）を設定すると実トークン発行
（Real プロバイダ）になる。未設定なら Fake 実装で発行する（通話以外の開発は
アカウント不要のまま可能）。Azure Speech トークンは引き続き Fake（A1 で差し替え）。

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
   seed 出力の `device_id` を `frontend/.env.local` の `NEXT_PUBLIC_DEFAULT_DEVICE_ID` に設定する。
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

## 停止・クリーンアップ

```bash
# コンテナ停止（データは volume に残る）
docker compose down

# volume ごと破棄（DB・Azurite のデータを消す）
docker compose down -v
```
