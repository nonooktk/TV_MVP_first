"""デバイス登録ルーター（新設・認証なし）。

docs/api/openapi.yaml の POST /devices/register に対応する。
高齢者側の待受ページが、初回登録リンクの registration_token を提示して
恒久的な device_token を受け取る。ワンタイム（使用済み・期限切れは拒否）。
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, status
from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.security import sha256_hex
from app.db.models import Device
from app.schemas import DeviceRegisterRequest, DeviceRegisterResponse

router = APIRouter(prefix="/devices", tags=["devices"])


@router.post(
    "/register",
    response_model=DeviceRegisterResponse,
    status_code=status.HTTP_200_OK,
)
def register_device(
    body: DeviceRegisterRequest,
    db: Session = Depends(get_db),
) -> DeviceRegisterResponse:
    """登録トークンと引き換えに device_token を発行する。"""
    token_hash = sha256_hex(body.registration_token)

    # 未使用の登録トークンハッシュに一致し、期限内で、まだ有効化されていないデバイス。
    device = db.scalars(
        select(Device).where(Device.registration_token_hash == token_hash)
    ).first()
    if device is None:
        # 使用済み（ハッシュ消去済み）または不正トークン。
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_token", "message": "登録トークンが無効です"},
        )

    now = datetime.now(timezone.utc)
    if device.registration_expires_at is None or device.registration_expires_at < now:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "expired", "message": "登録トークンの有効期限が切れています"},
        )

    # device_token を発行し、ハッシュのみ保存。登録トークンは使い切りでクリアする。
    device_token = secrets.token_urlsafe(32)
    device.device_token_hash = sha256_hex(device_token)
    device.status = "active"
    device.registered_at = now
    device.registration_token_hash = None
    device.registration_expires_at = None

    db.commit()

    return DeviceRegisterResponse(device_token=device_token)
