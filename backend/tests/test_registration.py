"""links/register → devices/register の一連（ワンタイム性・期限切れ）テスト。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.core.security import sha256_hex
from app.db.models import Device


def _extract_token(url: str) -> str:
    return url.split("token=", 1)[1]


def test_register_flow_happy(client, seeded, db, family_headers):
    """リンク発行 → デバイス登録でトークンが発行され active になる。"""
    res = client.post("/links/register", headers=family_headers)
    assert res.status_code == 201
    body = res.json()
    assert body["one_time"] is True
    token = _extract_token(body["url"])

    res2 = client.post("/devices/register", json={"registration_token": token})
    assert res2.status_code == 200
    device_token = res2.json()["device_token"]
    assert device_token

    # DB 側: active・device_token_hash 設定・registration_token_hash クリア
    db.expire_all()
    dev = db.scalars(
        select(Device).where(Device.device_token_hash == sha256_hex(device_token))
    ).first()
    assert dev is not None
    assert dev.status == "active"
    assert dev.registration_token_hash is None

    # 発行された device_token で待受APIが通る
    res3 = client.get("/calls/incoming", headers={"X-Device-Token": device_token})
    assert res3.status_code == 200


def test_register_token_one_time(client, seeded, family_headers):
    """登録トークンは使い切り。2回目は 401。"""
    body = client.post("/links/register", headers=family_headers).json()
    token = _extract_token(body["url"])
    assert client.post("/devices/register", json={"registration_token": token}).status_code == 200
    # 2回目は使用済み → 401
    assert client.post("/devices/register", json={"registration_token": token}).status_code == 401


def test_register_reissue_invalidates_old(client, seeded, family_headers):
    """再発行すると旧トークンは無効化される。"""
    first = client.post("/links/register", headers=family_headers).json()
    old_token = _extract_token(first["url"])
    second = client.post("/links/register", headers=family_headers).json()
    new_token = _extract_token(second["url"])
    assert old_token != new_token

    # 旧トークンは 401、新トークンは 200
    assert client.post("/devices/register", json={"registration_token": old_token}).status_code == 401
    assert client.post("/devices/register", json={"registration_token": new_token}).status_code == 200


def test_register_expired(client, seeded, db, family_headers):
    """期限切れの登録トークンは 400。"""
    body = client.post("/links/register", headers=family_headers).json()
    token = _extract_token(body["url"])

    # 期限を過去へ書き換える
    dev = db.scalars(
        select(Device).where(Device.registration_token_hash == sha256_hex(token))
    ).first()
    dev.registration_expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
    db.commit()

    res = client.post("/devices/register", json={"registration_token": token})
    assert res.status_code == 400


def test_register_invalid_token(client, seeded):
    """存在しない登録トークンは 401。"""
    res = client.post("/devices/register", json={"registration_token": "bogus"})
    assert res.status_code == 401
