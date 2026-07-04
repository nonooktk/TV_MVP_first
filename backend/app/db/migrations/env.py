"""Alembic 実行環境。

接続URLは環境変数 DATABASE_URL から読む（alembic.ini には書かない）。
target_metadata は models.Base.metadata。オフライン（--sql）／オンライン両対応。
"""

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# backend/ を import パスに追加し、app.db.models を解決できるようにする。
# このファイルは backend/app/db/migrations/env.py なので4つ上が backend/。
_BACKEND_ROOT = Path(__file__).resolve().parents[3]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.db import models  # noqa: E402

# Alembic Config オブジェクト（alembic.ini の値へのアクセス）
config = context.config

# 環境変数 DATABASE_URL を接続URLとして注入する。
# 未設定でもオフライン生成できるようダミーにフォールバックする。
_database_url = os.getenv("DATABASE_URL", "postgresql://localhost/dummy")
config.set_main_option("sqlalchemy.url", _database_url)

# ロギング設定
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# autogenerate や比較の対象メタデータ
target_metadata = models.Base.metadata


def run_migrations_offline() -> None:
    """オフラインモード（--sql）でマイグレーションを実行する。

    Engine を作らず、URLだけで context を構成する。SQL文を出力する用途。
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """オンラインモードでマイグレーションを実行する（実DBへ接続）。"""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
