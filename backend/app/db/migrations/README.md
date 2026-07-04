# migrations

Alembicによるマイグレーション置き場。

- 設定: `backend/alembic.ini`（`script_location = app/db/migrations`）
- 環境: `env.py`（接続URLは環境変数 `DATABASE_URL` から読む。`target_metadata` は
  `app.db.models.Base.metadata`。オフライン `--sql` にも対応）
- 初回: `versions/0001_initial.py`（手書き。`models.py` と完全一致。ENUM型の
  create/drop も明示）

## 適用手順（DBへ反映）

コマンドはすべて `backend/` ディレクトリで実行する。

```bash
cd backend

# 接続先を環境変数で渡す（例。本番はKey Vault＋マネージドID）
export DATABASE_URL="postgresql+psycopg2://<user>:<pass>@<host>:5432/<dbname>"

# 最新まで適用
alembic upgrade head

# 現在のリビジョン確認
alembic current

# ロールバック（1つ戻す）
alembic downgrade -1
```

## オフラインSQL生成手順（DDLをファイル出力）

DBに接続せず、適用予定のDDLをSQLとして出力する。レビューやDBA適用に使う。
`DATABASE_URL` はダミーでよいが、方言をPostgreSQLに合わせるため
`postgresql://` スキームを指定する。

```bash
cd backend

# 方言判定のためダミーでも postgresql:// を指定
export DATABASE_URL="postgresql://localhost/dummy"

# 空DB（base）から head までのDDLを標準出力へ
alembic upgrade head --sql

# ファイルに保存する場合
alembic upgrade head --sql > migration_head.sql
```
