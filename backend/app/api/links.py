"""初回登録リンク発行ルーター。

docs/api/openapi.yaml の /links/register に対応する。
owner ロールのみ実行可（require_family は owner を解決するスタブ）。

デバイスが無ければ作成し、登録トークン（secrets.token_urlsafe(32)）を発行して
sha256 を registration_token_hash に保存する。再発行は旧トークンを無効化（ハッシュ上書き）。
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_family
from app.core.config import Settings, get_settings
from app.core.security import sha256_hex
from app.db.models import Device, User
from app.schemas import RegisterLinkResponse

router = APIRouter(prefix="/links", tags=["links"])

# 登録リンクの有効期限（24時間）
_REGISTRATION_TTL = timedelta(hours=24)


@router.post(
    "/register",
    response_model=RegisterLinkResponse,
    status_code=status.HTTP_201_CREATED,
)
def register_link(
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> RegisterLinkResponse:
    """高齢者側デバイスの初回登録リンクを発行する。"""
    # 家族に紐づくデバイスを探す。無ければ owner を固定通話相手として新規作成する。
    device = db.scalars(
        select(Device).where(Device.family_id == user.family_id).order_by(
            Device.created_at
        )
    ).first()
    if device is None:
        device = Device(
            family_id=user.family_id,
            fixed_contact_user_id=user.id,
            status="pending",
        )
        db.add(device)

    # 登録トークンを発行し、ハッシュのみ保存（再発行は旧ハッシュを上書きして無効化）。
    raw_token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + _REGISTRATION_TTL
    device.registration_token_hash = sha256_hex(raw_token)
    device.registration_expires_at = expires_at
    device.status = "pending"

    db.commit()

    url = f"{settings.FRONTEND_BASE_URL}/elder/register?token={raw_token}"
    return RegisterLinkResponse(url=url, expires_at=expires_at, one_time=True)
