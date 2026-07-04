"""DB セッション管理（同期 SQLAlchemy 2.0・sessionmaker）。

FastAPI の依存 `get_db` でリクエストスコープのセッションを供給する。
接続URLは settings.DATABASE_URL（.env）から読む。
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

_settings = get_settings()

# 同期エンジン。psycopg2 ドライバを使う（DATABASE_URL は postgresql://…）。
engine = create_engine(
    _settings.DATABASE_URL,
    pool_pre_ping=True,
    future=True,
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    future=True,
)


def get_db() -> Iterator[Session]:
    """リクエストスコープの DB セッションを供給する FastAPI 依存。

    正常終了時はコミットせず（各ハンドラで明示コミット）、例外時はロールバックし、
    最後に必ずクローズする。
    """
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
