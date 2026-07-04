"""開発用シード投入スクリプト（冪等）。

投入するもの:
- family（name=テスト家族）
- owner ユーザー（家族の管理者）
- active デバイス（device_token="dev-device-token" のハッシュを登録）

再実行しても重複しないよう、既存レコードがあれば再利用する。
ただしデバイスのトークンは、POST /devices/register の手動確認等でローテーション
され得るため、**再実行のたびに既知値（dev-device-token）のハッシュへリセット**し、
status=active も保証する（デバイス認証系の手動確認を常に既知トークンで行えるようにする）。
使用トークン（家族側 Bearer・デバイストークン）を標準出力に表示する。

実行:
    cd backend
    source .venv/bin/activate
    DATABASE_URL=postgresql://tvmvp:tvmvp_dev_password@localhost:5433/tvmvp python scripts/seed.py
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

# backend/ を import パスに追加する（このファイルは backend/scripts/seed.py）。
_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import select  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.core.security import sha256_hex  # noqa: E402
from app.db.models import Device, Family, User  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402

FAMILY_NAME = "テスト家族"
DEVICE_TOKEN = "dev-device-token"


def seed() -> None:
    settings = get_settings()
    db = SessionLocal()
    try:
        # family（name 一致で再利用）
        family = db.scalars(
            select(Family).where(Family.name == FAMILY_NAME)
        ).first()
        if family is None:
            family = Family(name=FAMILY_NAME)
            db.add(family)
            db.flush()

        # owner ユーザー（家族に1人だけ想定。無ければ作成）
        owner = db.scalars(
            select(User).where(User.family_id == family.id, User.role == "owner")
        ).first()
        if owner is None:
            owner = User(family_id=family.id, role="owner", auth_id="dev-owner")
            db.add(owner)
            db.flush()

        # デバイス（family 一致で再利用。行の重複作成はしない）。
        # トークンハッシュで検索しない: /devices/register の手動確認でトークンが
        # ローテーションされると既知ハッシュでは見つからず、重複作成してしまうため。
        token_hash = sha256_hex(DEVICE_TOKEN)
        device = db.scalars(
            select(Device)
            .where(Device.family_id == family.id)
            .order_by(Device.created_at)
        ).first()
        token_reset = False
        if device is None:
            device = Device(
                family_id=family.id,
                fixed_contact_user_id=owner.id,
                status="active",
                device_token_hash=token_hash,
                registered_at=datetime.now(timezone.utc),
            )
            db.add(device)
            db.flush()
        else:
            # 既存デバイスは毎回、既知トークンのハッシュへリセットし active を保証する。
            token_reset = (
                device.device_token_hash != token_hash or device.status != "active"
            )
            device.device_token_hash = token_hash
            device.status = "active"
            if device.registered_at is None:
                device.registered_at = datetime.now(timezone.utc)

        db.commit()

        print("=== シード完了（冪等）===")
        print(f"family_id           : {family.id}")
        print(f"owner user_id       : {owner.id}")
        print(f"device_id           : {device.id}")
        if token_reset:
            print("※ 既存デバイスのトークンを既知値（dev-device-token）にリセットし、"
                  "status=active を保証しました")
        print("--- 使用トークン ---")
        print(f"家族側 Bearer トークン : {settings.DEV_FAMILY_TOKEN}")
        print(f"  Authorization: Bearer {settings.DEV_FAMILY_TOKEN}")
        print(f"デバイストークン       : {DEVICE_TOKEN}")
        print(f"  X-Device-Token: {DEVICE_TOKEN}")
    finally:
        db.close()


if __name__ == "__main__":
    seed()
