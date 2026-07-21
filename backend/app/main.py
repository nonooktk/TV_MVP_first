"""FastAPIアプリのエントリポイント。

ルーター（tokens, calls, media, albums, links, devices）を登録する。
認証は2系統（家族=Bearer スタブ / 高齢者=X-Device-Token）で、各ルーターの依存で解決する。
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import albums, calls, devices, links, media, tokens
from app.core.config import get_settings
from app.services.blob import BlobService
from app.services.queue import QueueService

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """起動時に Blob コンテナとキューを best-effort で用意する（冪等）。

    ストレージ未起動でもアプリ自体は起動できるよう、失敗は警告に留める。
    """
    settings = get_settings()
    try:
        BlobService(
            settings.AZURE_STORAGE_CONNECTION_STRING, settings.MEDIA_CONTAINER
        ).ensure_container()
        QueueService(
            settings.AZURE_STORAGE_CONNECTION_STRING, settings.QUEUE_NAME
        ).ensure_queue()
    except Exception:  # noqa: BLE001
        logger.warning("ストレージ初期化をスキップしました（接続不可）", exc_info=True)
    yield


app = FastAPI(title="TV電話MVP API", version="0.2.0", lifespan=lifespan)


def _cors_origins() -> list[str]:
    """許可オリジンを決める。

    既定は localhost:3000（ローカル開発）。本番（Azure）は Static Web Apps の
    オリジンを環境変数 ``CORS_ALLOW_ORIGINS``（カンマ区切り）で追加する。
    例: ``CORS_ALLOW_ORIGINS=https://xxx.azurestaticapps.net`` または
    ``http://localhost:3000,https://xxx.azurestaticapps.net``。
    空・未設定なら localhost:3000 のみを既定として残す。
    """
    raw = os.environ.get("CORS_ALLOW_ORIGINS", "").strip()
    if not raw:
        return ["http://localhost:3000"]
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    # 明示指定でも localhost:3000 は既定として維持する（ローカル開発を壊さない）。
    if "http://localhost:3000" not in origins:
        origins.append("http://localhost:3000")
    return origins


# frontend からの CORS を許可する。ローカルは localhost:3000、本番は SWA URL を
# 環境変数 CORS_ALLOW_ORIGINS（カンマ区切り）で追加する（A1 でコンテナに設定）。
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_security_headers(request, call_next):
    """全レスポンスに X-Content-Type-Options: nosniff を付与する。

    F-7（SECURITY_REPORT_2026-07-19）対応: DAST(baseline) が /healthz・/openapi.json 等の
    API レスポンスに nosniff 欠落を検出したため、MIME スニッフィング抑止を横断的に付与する。
    """
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/healthz", tags=["health"])
def healthz() -> dict:
    """ヘルスチェック。"""
    return {"status": "ok"}


app.include_router(tokens.router)
app.include_router(calls.router)
app.include_router(media.router)
app.include_router(albums.router)
app.include_router(links.router)
app.include_router(devices.router)
