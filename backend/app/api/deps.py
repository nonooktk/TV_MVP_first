"""FastAPI の共通依存（認証2系統・サービスDI）。

- 家族認証（`require_family`）: Authorization: Bearer が settings.DEV_FAMILY_TOKEN と一致すれば
  シード済みの owner ユーザーへ解決する（スタブ。将来 Entra に差し替え可能な形）。
- デバイス認証（`require_device`）: X-Device-Token を sha256 して devices.device_token_hash と
  照合する（status=active のみ通す）。こちらは本実装。

Blob/Queue/Agora/Speech の各サービスは、テスト時に差し替えられるよう依存として供給する。
"""

from __future__ import annotations

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.security import sha256_hex
from app.db.models import Device, User
from app.db.session import get_db
from app.services.agora import (
    AgoraTokenProvider,
    FakeAgoraTokenProvider,
    RealAgoraTokenProvider,
)
from app.services.blob import BlobService
from app.services.queue import QueueService
from app.services.speech import (
    FakeSpeechTokenProvider,
    RealSpeechTokenProvider,
    SpeechTokenProvider,
)


# --- 認証 ---------------------------------------------------------------------


def require_family(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    """家族認証（Bearer スタブ）。owner ユーザーへ解決する。

    Authorization: Bearer <token> が settings.DEV_FAMILY_TOKEN と一致することを確認し、
    シード済みの owner ユーザーを返す。将来はここを Entra 検証に差し替える。
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "Bearer トークンが必要です"},
        )
    token = authorization.split(" ", 1)[1].strip()
    if token != settings.DEV_FAMILY_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "トークンが無効です"},
        )

    # スタブでは owner ユーザー（シード済み）へ解決する。
    user = db.scalars(
        select(User).where(User.role == "owner").order_by(User.created_at)
    ).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "unauthorized",
                "message": "owner ユーザーが未シードです（seed.py を実行してください）",
            },
        )
    return user


def require_device(
    x_device_token: str | None = Header(default=None, alias="X-Device-Token"),
    db: Session = Depends(get_db),
) -> Device:
    """デバイス認証（本実装）。X-Device-Token を sha256 照合する。

    status=active のデバイスのみ通す。pending / revoked や不一致は 401。
    """
    if not x_device_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "X-Device-Token が必要です"},
        )
    token_hash = sha256_hex(x_device_token)
    device = db.scalars(
        select(Device).where(
            Device.device_token_hash == token_hash,
            Device.status == "active",
        )
    ).first()
    if device is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "デバイストークンが無効です"},
        )
    return device


def require_family_or_device(
    authorization: str | None = Header(default=None),
    x_device_token: str | None = Header(default=None, alias="X-Device-Token"),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> tuple[User | None, Device | None]:
    """家族 Bearer・デバイス X-Device-Token の**どちらでも**通す認証。

    POST /calls/{call_id}/end のように両側から呼べる操作で使う。
    Bearer が提示されていれば家族として、無ければ X-Device-Token をデバイスとして
    検証する。戻り値は (user, None) か (None, device)。どちらも無ければ 401。
    """
    if authorization:
        user = require_family(authorization=authorization, db=db, settings=settings)
        return user, None
    if x_device_token:
        device = require_device(x_device_token=x_device_token, db=db)
        return None, device
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={
            "code": "unauthorized",
            "message": "Bearer または X-Device-Token が必要です",
        },
    )


# --- サービスDI（テスト時に app.dependency_overrides で差し替える）-------------


def get_blob_service(
    settings: Settings = Depends(get_settings),
) -> BlobService:
    """Blob サービス（SAS発行・アップロード）を供給する。"""
    return BlobService(
        connection_string=settings.AZURE_STORAGE_CONNECTION_STRING,
        container=settings.MEDIA_CONTAINER,
    )


def get_queue_service(
    settings: Settings = Depends(get_settings),
) -> QueueService:
    """Queue サービス（パイプライン投函）を供給する。"""
    return QueueService(
        connection_string=settings.AZURE_STORAGE_CONNECTION_STRING,
        queue_name=settings.QUEUE_NAME,
    )


def get_agora_provider(
    settings: Settings = Depends(get_settings),
) -> AgoraTokenProvider:
    """Agora トークンプロバイダを供給する（M1: 設定に応じて自動切替）。

    AGORA_APP_ID と AGORA_APP_CERTIFICATE の両方が非空なら Real、
    どちらか欠けていれば Fake を返す（証明書未設定のデモ環境を壊さない）。
    """
    if settings.AGORA_APP_ID and settings.AGORA_APP_CERTIFICATE:
        return RealAgoraTokenProvider(
            app_id=settings.AGORA_APP_ID,
            app_certificate=settings.AGORA_APP_CERTIFICATE,
        )
    return FakeAgoraTokenProvider()


def get_speech_provider(
    settings: Settings = Depends(get_settings),
) -> SpeechTokenProvider:
    """Speech トークンプロバイダを供給する（STT: 設定に応じて自動切替）。

    AZURE_SPEECH_KEY と AZURE_SPEECH_REGION の両方が非空なら Real（STS 短命トークン）、
    どちらか欠けていれば Fake を返す（Speech 未設定のデモ環境を壊さない。Agora と同じ）。
    """
    if settings.AZURE_SPEECH_KEY and settings.AZURE_SPEECH_REGION:
        return RealSpeechTokenProvider(
            key=settings.AZURE_SPEECH_KEY,
            region=settings.AZURE_SPEECH_REGION,
        )
    return FakeSpeechTokenProvider()
