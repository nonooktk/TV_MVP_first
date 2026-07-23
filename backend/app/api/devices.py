"""デバイスルーター。

docs/api/openapi.yaml の以下に対応する:
- POST /devices/register（認証なし）: 高齢者側の待受ページが、初回登録リンクの
  registration_token を提示して恒久的な device_token を受け取る。ワンタイム
  （使用済み・期限切れは拒否）。
- GET /devices（家族 Bearer）: 自家族のデバイス一覧（1件想定）を返す（設定モーダルでの
  現在名表示用）。
- PATCH /devices/{device_id}（家族 Bearer・owner のみ）: デバイスの表示名を更新する。

認証なしの /devices/register と、認証ありの GET/PATCH を同じルーターに同居させるが、
依存（require_family）は各ルートに個別付与するため、/devices/register には影響しない。
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_family
from app.api.device_selection import device_priority_order
from app.core.security import sha256_hex
from app.db.models import Device, User
from app.schemas import (
    DeviceInfo,
    DeviceList,
    DeviceRegisterRequest,
    DeviceRegisterResponse,
    DeviceUpdateRequest,
)

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


@router.get("", response_model=DeviceList)
def list_devices(
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
) -> DeviceList:
    """自家族のデバイス一覧（1件想定）を返す（家族 Bearer）。

    設定モーダルで現在の表示名・登録状態を出すために使う。自家族に帰属する
    デバイスのみを返す（family_id で絞り込むため IDOR の越境は起きない）。

    並びは発信自動解決（POST /calls）と共通の `device_priority_order()` を使う。
    これにより先頭（active があればその中で registered_at 最新）が発信対象と一致し、
    フロントが items[0] を名前設定対象にしても発信端末とズレない（複数端末時対策）。
    """
    devices = db.scalars(
        select(Device)
        .where(Device.family_id == user.family_id)
        .order_by(*device_priority_order())
    ).all()
    return DeviceList(
        items=[
            DeviceInfo(
                device_id=d.id,
                display_name=d.display_name,
                status=d.status,
                registered_at=d.registered_at,
            )
            for d in devices
        ]
    )


@router.patch("/{device_id}", response_model=DeviceInfo)
def update_device(
    device_id: UUID,
    body: DeviceUpdateRequest,
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
) -> DeviceInfo:
    """デバイスの表示名を更新する（家族 Bearer・owner のみ）。

    認可: owner のみ（viewer は 403。links の登録リンク発行・albums の削除と同方針）。
    帰属: 対象 device が自家族に属することを検証する（他家族の device は存在を秘匿して
    404＝IDOR 対策）。display_name は 30 文字まで（Pydantic で検証）。空文字・空白のみは
    未設定（null）扱いにする。
    """
    # 認可: owner のみ（viewer は 403）。
    if user.role != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "名前の変更は owner のみ実行できます"},
        )

    device = db.get(Device, device_id)
    if device is None or device.family_id != user.family_id:
        # 帰属しないデバイスは存在を秘匿して 404。
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "デバイスが見つかりません"},
        )

    # 空文字・空白のみは未設定（null）にする。前後の空白は除去して保存する。
    name = body.display_name.strip() if body.display_name is not None else None
    device.display_name = name if name else None
    db.commit()
    db.refresh(device)

    return DeviceInfo(
        device_id=device.id,
        display_name=device.display_name,
        status=device.status,
        registered_at=device.registered_at,
    )
