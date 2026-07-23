"""GET /devices・PATCH /devices/{device_id}（表示名）のテスト。

タスクB（通話参加者の名前表示・Zoom風ラベル）で新設したエンドポイントを検証する。
- 正常系: owner が表示名を設定・取得できる。空文字・空白のみは null 扱い。30字上限。
- 認可: viewer は 403。他家族の device への PATCH は 404（IDOR 対策）。
- GET /devices は自家族の device のみ返す（family_id 絞り込み）。

viewer・他家族の再現は test_idor_manual.py と同じく require_family の override で行う
（ルーターは user.family_id / user.role のみ参照するため非永続 User で足りる）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import select

from app.api.deps import require_family
from app.db.models import Device, Family, User
from app.main import app


def _as_user(family_id, role="owner"):
    """require_family を「指定 family_id・指定ロールのユーザー」に差し替える override。"""

    def _override() -> User:
        return User(id=uuid4(), family_id=family_id, role=role, auth_id="test-role")

    return _override


def _make_other_family_with_device(db) -> Device:
    """別家族＋その active デバイスを作って返す（IDOR 検証用）。"""
    fam = Family(name="別の家族")
    db.add(fam)
    db.flush()
    owner = User(family_id=fam.id, role="owner", auth_id="other-owner")
    db.add(owner)
    db.flush()
    device = Device(
        family_id=fam.id,
        fixed_contact_user_id=owner.id,
        status="active",
        registered_at=datetime.now(timezone.utc),
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


# --- GET /devices -------------------------------------------------------------


def test_get_devices_returns_own_family_device(client, seeded, family_headers):
    """自家族のデバイス一覧を返す（初期は display_name=null・status=active）。"""
    res = client.get("/devices", headers=family_headers)
    assert res.status_code == 200, res.text
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["device_id"] == str(seeded["device_id"])
    assert items[0]["display_name"] is None
    assert items[0]["status"] == "active"


def test_get_devices_only_own_family(client, seeded, db, family_headers):
    """他家族のデバイスは返さない（family_id で絞り込む）。"""
    other = _make_other_family_with_device(db)
    res = client.get("/devices", headers=family_headers)
    assert res.status_code == 200, res.text
    ids = {item["device_id"] for item in res.json()["items"]}
    assert str(seeded["device_id"]) in ids
    assert str(other.id) not in ids


def test_get_devices_requires_auth(client, seeded):
    """Bearer なしは 401。"""
    res = client.get("/devices")
    assert res.status_code == 401, res.text


def test_get_devices_head_matches_call_resolution(client, seeded, db, family_headers):
    """複数端末時、GET /devices の先頭が発信自動解決の対象デバイスと一致する（修正1）。

    名前設定モーダルは items[0] を対象に PATCH するため、これが発信端末と一致しないと
    「名前を付けた端末」と「実際に通話する端末」がズレる。共通の並び順で揃うことを検証する。
    """
    # seeded の active デバイスは registered_at=now。より新しい active と、pending を追加する。
    newer_active = Device(
        family_id=seeded["family_id"],
        fixed_contact_user_id=seeded["owner_id"],
        status="active",
        registered_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    pending = Device(
        family_id=seeded["family_id"],
        fixed_contact_user_id=seeded["owner_id"],
        status="pending",
    )
    db.add_all([newer_active, pending])
    db.commit()
    db.refresh(newer_active)

    # 発信（device_id 省略）で自動解決される端末を取得。
    call = client.post("/calls", headers=family_headers, json={}).json()
    resolved_device_id = call["device_id"]

    # GET /devices の先頭が発信解決の端末と一致すること。
    res = client.get("/devices", headers=family_headers)
    assert res.status_code == 200, res.text
    items = res.json()["items"]
    assert items[0]["device_id"] == resolved_device_id
    assert items[0]["device_id"] == str(newer_active.id)
    # active が pending より前に来る（active 最優先）。
    statuses = [i["status"] for i in items]
    assert statuses.index("active") < statuses.index("pending")


# --- PATCH /devices/{device_id}（正常系）--------------------------------------


def test_patch_display_name_owner(client, seeded, db, family_headers):
    """owner は表示名を設定でき、DB にも反映される。"""
    res = client.patch(
        f"/devices/{seeded['device_id']}",
        headers=family_headers,
        json={"display_name": "おばあちゃん"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["display_name"] == "おばあちゃん"

    db.expire_all()
    dev = db.get(Device, seeded["device_id"])
    assert dev.display_name == "おばあちゃん"


def test_patch_trims_whitespace(client, seeded, db, family_headers):
    """前後の空白は除去して保存する。"""
    res = client.patch(
        f"/devices/{seeded['device_id']}",
        headers=family_headers,
        json={"display_name": "  おじいちゃん  "},
    )
    assert res.status_code == 200, res.text
    assert res.json()["display_name"] == "おじいちゃん"


def test_patch_empty_string_becomes_null(client, seeded, db, family_headers):
    """空文字・空白のみは未設定（null）扱いにする。"""
    # まず設定してから、空文字でクリアする。
    client.patch(
        f"/devices/{seeded['device_id']}",
        headers=family_headers,
        json={"display_name": "テスト"},
    )
    res = client.patch(
        f"/devices/{seeded['device_id']}",
        headers=family_headers,
        json={"display_name": "   "},
    )
    assert res.status_code == 200, res.text
    assert res.json()["display_name"] is None

    db.expire_all()
    dev = db.get(Device, seeded["device_id"])
    assert dev.display_name is None


def test_patch_null_becomes_null(client, seeded, family_headers):
    """display_name=null 明示でも未設定になる。"""
    res = client.patch(
        f"/devices/{seeded['device_id']}",
        headers=family_headers,
        json={"display_name": None},
    )
    assert res.status_code == 200, res.text
    assert res.json()["display_name"] is None


def test_patch_too_long_rejected(client, seeded, family_headers):
    """30 文字超は Pydantic 検証で 422。"""
    res = client.patch(
        f"/devices/{seeded['device_id']}",
        headers=family_headers,
        json={"display_name": "あ" * 31},
    )
    assert res.status_code == 422, res.text


def test_patch_exactly_30_chars_ok(client, seeded, family_headers):
    """ちょうど 30 文字は許可。"""
    name = "あ" * 30
    res = client.patch(
        f"/devices/{seeded['device_id']}",
        headers=family_headers,
        json={"display_name": name},
    )
    assert res.status_code == 200, res.text
    assert res.json()["display_name"] == name


# --- PATCH /devices/{device_id}（認可）----------------------------------------


def test_patch_viewer_forbidden(client, seeded, db):
    """viewer は 403（owner のみ編集可）。DB は変更されない。"""
    app.dependency_overrides[require_family] = _as_user(
        seeded["family_id"], role="viewer"
    )
    try:
        res = client.patch(
            f"/devices/{seeded['device_id']}",
            json={"display_name": "勝手に変更"},
        )
        assert res.status_code == 403, f"viewer が編集できてしまった: {res.text}"
    finally:
        app.dependency_overrides.pop(require_family, None)

    db.expire_all()
    dev = db.get(Device, seeded["device_id"])
    assert dev.display_name is None


def test_patch_other_family_device_404(client, seeded, db):
    """他家族の device への PATCH は 404（存在秘匿・IDOR 対策）。"""
    other = _make_other_family_with_device(db)
    # 家族A（seeded）の owner として、家族B の device を叩く。
    app.dependency_overrides[require_family] = _as_user(
        seeded["family_id"], role="owner"
    )
    try:
        res = client.patch(
            f"/devices/{other.id}",
            json={"display_name": "越境"},
        )
        assert res.status_code == 404, f"他家族の device を編集できてしまった: {res.text}"
    finally:
        app.dependency_overrides.pop(require_family, None)

    # 家族B の device は変更されていない。
    db.expire_all()
    dev = db.get(Device, other.id)
    assert dev.display_name is None


def test_patch_unknown_device_404(client, seeded, family_headers):
    """存在しない device_id は 404。"""
    res = client.patch(
        f"/devices/{uuid4()}",
        headers=family_headers,
        json={"display_name": "なにか"},
    )
    assert res.status_code == 404, res.text


def test_patch_requires_auth(client, seeded):
    """Bearer なしは 401。"""
    res = client.patch(
        f"/devices/{seeded['device_id']}",
        json={"display_name": "なにか"},
    )
    assert res.status_code == 401, res.text
