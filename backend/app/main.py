"""FastAPIアプリのエントリポイント。

ルーター（tokens, calls, media, albums, links, devices）を登録する。
認証は2系統（家族=Bearer スタブ / 高齢者=X-Device-Token）で、各ルーターの依存で解決する。
"""

from __future__ import annotations

import logging
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

# Phase 3: frontend（Next.js dev server）からのローカル疎通用に CORS を許可する。
# 対象は localhost:3000 のみ（本番は Azure Static Web Apps 等のオリジンに差し替え予定）。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
