"""GET /users/me・PATCH /users/me（自分の表示名）のテスト。

機能A（家族側メンバーの表示名・v0.7.0）で新設したエンドポイントを検証する。
- 正常系: 自分の情報取得（id/role/display_name）。表示名の設定・取得。空文字・空白は null 化。30字上限。
- 認可: owner / viewer とも「自分の」名前は設定できる。本人限定（他人のレコードには影響しない）。

本人限定の検証は、require_family の override を「指定 user_id を route の DB セッションから
ロードして返す」形にして行う（PATCH が commit/refresh するため、route セッションに attach された
永続ユーザーである必要がある）。dev トークンは _resolve_dev_family_owner で seeded owner に解決される。
"""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_family
from app.db.models import Family, User
from app.main import app


def _auth_as(user_id):
    """require_family を「指定 user_id を route の DB セッションからロードして返す」override。

    override 自身が Depends(get_db) を宣言することで、ルートと同一のリクエストセッションを得る
    （FastAPI は同一リクエスト内で get_db をキャッシュする）。これにより PATCH の
    db.commit()/db.refresh(user) が正しく動く（transient/別セッションのユーザーだと失敗する）。
    """

    def _override(db: Session = Depends(get_db)) -> User:
        return db.get(User, user_id)

    return _override


def _make_user(db, role="owner", display_name=None) -> User:
    """新しい家族＋そのロールのユーザーを1名作って返す（永続）。"""
    fam = Family(name="別家族")
    db.add(fam)
    db.flush()
    user = User(family_id=fam.id, role=role, auth_id=f"auth-{role}-{id(fam)}",
                display_name=display_name)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


# --- GET /users/me ------------------------------------------------------------


def test_get_me_returns_self(client, seeded, family_headers):
    """自分の id・role・display_name を返す（初期は display_name=null）。"""
    res = client.get("/users/me", headers=family_headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["id"] == str(seeded["owner_id"])
    assert body["role"] == "owner"
    assert body["display_name"] is None


def test_get_me_requires_auth(client, seeded):
    """Bearer なしは 401。"""
    res = client.get("/users/me")
    assert res.status_code == 401, res.text


# --- PATCH /users/me（正常系）-------------------------------------------------


def test_patch_me_sets_name(client, seeded, db, family_headers):
    """自分の表示名を設定でき、DB にも反映される。"""
    res = client.patch(
        "/users/me", headers=family_headers, json={"display_name": "たろう"}
    )
    assert res.status_code == 200, res.text
    assert res.json()["display_name"] == "たろう"

    db.expire_all()
    user = db.get(User, seeded["owner_id"])
    assert user.display_name == "たろう"


def test_patch_me_get_roundtrip(client, seeded, family_headers):
    """設定した名前が GET /users/me で取得できる。"""
    client.patch("/users/me", headers=family_headers, json={"display_name": "はなこ"})
    res = client.get("/users/me", headers=family_headers)
    assert res.status_code == 200, res.text
    assert res.json()["display_name"] == "はなこ"


def test_patch_me_trims_whitespace(client, seeded, family_headers):
    """前後の空白は除去して保存する。"""
    res = client.patch(
        "/users/me", headers=family_headers, json={"display_name": "  たろう  "}
    )
    assert res.status_code == 200, res.text
    assert res.json()["display_name"] == "たろう"


def test_patch_me_empty_string_becomes_null(client, seeded, db, family_headers):
    """空白のみは未設定（null）扱いにする。"""
    client.patch("/users/me", headers=family_headers, json={"display_name": "テスト"})
    res = client.patch(
        "/users/me", headers=family_headers, json={"display_name": "   "}
    )
    assert res.status_code == 200, res.text
    assert res.json()["display_name"] is None

    db.expire_all()
    user = db.get(User, seeded["owner_id"])
    assert user.display_name is None


def test_patch_me_null_becomes_null(client, seeded, family_headers):
    """display_name=null 明示でも未設定になる。"""
    res = client.patch(
        "/users/me", headers=family_headers, json={"display_name": None}
    )
    assert res.status_code == 200, res.text
    assert res.json()["display_name"] is None


def test_patch_me_too_long_rejected(client, seeded, family_headers):
    """30 文字超は Pydantic 検証で 422。"""
    res = client.patch(
        "/users/me", headers=family_headers, json={"display_name": "あ" * 31}
    )
    assert res.status_code == 422, res.text


def test_patch_me_exactly_30_chars_ok(client, seeded, family_headers):
    """ちょうど 30 文字は許可。"""
    name = "あ" * 30
    res = client.patch("/users/me", headers=family_headers, json={"display_name": name})
    assert res.status_code == 200, res.text
    assert res.json()["display_name"] == name


def test_patch_me_requires_auth(client, seeded):
    """Bearer なしは 401。"""
    res = client.patch("/users/me", json={"display_name": "なにか"})
    assert res.status_code == 401, res.text


# --- PATCH /users/me（認可: owner/viewer 双方・本人限定）-----------------------


def test_owner_and_viewer_can_set_own_name(client, db):
    """owner / viewer とも「自分の」名前を設定できる（デバイス名の owner 限定とは別）。"""
    owner = _make_user(db, role="owner")
    viewer = _make_user(db, role="viewer")

    for u in (owner, viewer):
        app.dependency_overrides[require_family] = _auth_as(u.id)
        try:
            res = client.patch("/users/me", json={"display_name": f"{u.role}名"})
            assert res.status_code == 200, res.text
            assert res.json()["display_name"] == f"{u.role}名"
            assert res.json()["role"] == u.role
        finally:
            app.dependency_overrides.pop(require_family, None)

    db.expire_all()
    assert db.get(User, owner.id).display_name == "owner名"
    assert db.get(User, viewer.id).display_name == "viewer名"


def test_patch_me_only_affects_self(client, db):
    """本人限定: 自分を更新しても他人（別ユーザー）の display_name は変わらない。"""
    user_a = _make_user(db, role="owner")
    user_b = _make_user(db, role="viewer")

    # A として自分の名前を設定する。
    app.dependency_overrides[require_family] = _auth_as(user_a.id)
    try:
        res = client.patch("/users/me", json={"display_name": "Aの名前"})
        assert res.status_code == 200, res.text
    finally:
        app.dependency_overrides.pop(require_family, None)

    db.expire_all()
    # A は更新され、B は不変（他人のレコードに影響しない＝本人限定・IDOR の余地なし）。
    assert db.get(User, user_a.id).display_name == "Aの名前"
    assert db.get(User, user_b.id).display_name is None


# --- 着信ポーリングの caller_display_name 解決 --------------------------------


def test_incoming_caller_display_name_set(client, seeded, db, family_headers, device_headers):
    """発信者（owner）に display_name を設定すると incoming が caller_display_name を返す。"""
    owner = db.get(User, seeded["owner_id"])
    owner.display_name = "たろう"
    db.commit()

    # 発信（dev トークン → seeded owner が caller_user_id になる）。
    client.post("/calls", headers=family_headers,
                json={"device_id": str(seeded["device_id"])})
    inc = client.get("/calls/incoming", headers=device_headers)
    assert inc.status_code == 200, inc.text
    body = inc.json()
    assert body["incoming"] is True
    assert body["caller_display_name"] == "たろう"
    # family_name は互換維持のため併存する。
    assert body["family_name"] == "テスト家族"


def test_incoming_caller_display_name_unset_is_null(client, seeded, family_headers, device_headers):
    """発信者に display_name 未設定なら caller_display_name は null。"""
    client.post("/calls", headers=family_headers,
                json={"device_id": str(seeded["device_id"])})
    inc = client.get("/calls/incoming", headers=device_headers)
    assert inc.status_code == 200, inc.text
    body = inc.json()
    assert body["incoming"] is True
    assert body["caller_display_name"] is None
    assert body["family_name"] == "テスト家族"


def test_incoming_caller_null_is_null(client, seeded, db, device_headers):
    """caller_user_id が null（発信者不明）の通話は caller_display_name が null。"""
    from app.db.models import Call

    call = Call(
        family_id=seeded["family_id"],
        device_id=seeded["device_id"],
        caller_user_id=None,
        channel_name="ch-callernull",
        status="calling",
    )
    db.add(call)
    db.commit()

    inc = client.get("/calls/incoming", headers=device_headers)
    assert inc.status_code == 200, inc.text
    body = inc.json()
    assert body["incoming"] is True
    assert body["caller_display_name"] is None
