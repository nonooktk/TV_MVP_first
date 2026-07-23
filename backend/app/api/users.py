"""ユーザールーター（家族メンバー自身の表示名）。

docs/api/openapi.yaml の以下に対応する（v0.7.0）:
- GET /users/me（家族 Bearer）: 認証ユーザー自身の id・role・display_name を返す。
- PATCH /users/me（家族 Bearer）: 認証ユーザー自身の display_name を更新する。

**本人のみ**: どちらも path/body にユーザーIDを取らず、require_family が解決した
「認証ユーザー自身」の User レコードだけを対象にする。他人のレコードには構造上一切触れない
（IDOR の余地がない）。owner / viewer とも自分の名前は設定できる（デバイス名の owner 限定とは別）。

display_name の規則は PATCH /devices/{device_id}（app/api/devices.py）と同じ:
30 文字上限（Pydantic）・空文字/空白のみは null 化・前後の空白は除去して保存する。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_family
from app.db.models import User
from app.schemas import UserMe, UserUpdateRequest

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me", response_model=UserMe)
def get_me(
    user: User = Depends(require_family),
) -> UserMe:
    """認証ユーザー自身の情報を返す（家族 Bearer）。"""
    return UserMe(id=user.id, role=user.role, display_name=user.display_name)


@router.patch("/me", response_model=UserMe)
def update_me(
    body: UserUpdateRequest,
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
) -> UserMe:
    """認証ユーザー自身の表示名を更新する（家族 Bearer・本人のみ）。

    owner / viewer とも自分の名前は設定できる。display_name は 30 文字まで（Pydantic）。
    空文字・空白のみは未設定（null）扱いにする（前後の空白は除去して保存）。
    """
    # 空文字・空白のみは未設定（null）にする。前後の空白は除去して保存する
    # （PATCH /devices/{device_id} と同一の規則・実装）。
    name = body.display_name.strip() if body.display_name is not None else None
    user.display_name = name if name else None
    db.commit()
    db.refresh(user)

    return UserMe(id=user.id, role=user.role, display_name=user.display_name)
