"""Entra ID（家族側ログイン本実装）の検証・自動プロビジョニング・分離テスト。

3種類のレイヤーで検証する:

1. JWT 検証ロジック（app.core.entra.verify_entra_token）を、自前の RSA 鍵で署名した
   トークン＋モックした JWKS で検証する（正常・期限切れ・aud不一致・改ざん・iss形式・scp）。
2. 初回プロビジョニング（require_family 経由）: 未知の auth_id で家族＋owner が作られ、
   2回目は同一家族に解決される。dev トークン併存の回帰も確認する。
3. 分離: 他人の Entra トークンでは他人の家族のアルバムが見えない。

いずれも ENTRA_CLIENT_ID を設定した状態でのみ有効。verify_entra_token の署名検証は
モック鍵に差し替えるため、実 Microsoft への通信は行わない。
"""

from __future__ import annotations

import datetime as dt
from datetime import datetime, timezone
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core import entra
from app.core.config import get_settings
from app.db.models import Album, Call, Memory

TEST_CLIENT_ID = "11111111-2222-3333-4444-555555555555"
VALID_TID = "9188040d-6c67-4c5b-b112-36a304b66dad"  # 個人 MSA（consumers）
VALID_ISS = f"https://login.microsoftonline.com/{VALID_TID}/v2.0"


# --- 1. JWT 検証ロジックの単体テスト -------------------------------------------


@pytest.fixture
def rsa_key():
    """署名・検証に使う RSA 鍵ペア（テスト内で生成）。"""
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(autouse=True)
def _mock_jwks(monkeypatch, rsa_key):
    """PyJWKClient を差し替え、テスト鍵の公開鍵を署名鍵として返す。

    verify_entra_token は _get_jwk_client().get_signing_key_from_jwt(token) で
    署名鍵を取得する。ここをテスト鍵に固定し、実 JWKS への通信を防ぐ。
    """

    class _FakeSigningKey:
        def __init__(self, public_key):
            self.key = public_key

    class _FakeJWKClient:
        def __init__(self, public_key):
            self._public_key = public_key

        def get_signing_key_from_jwt(self, token):  # noqa: D102
            return _FakeSigningKey(self._public_key)

    fake = _FakeJWKClient(rsa_key.public_key())
    monkeypatch.setattr(entra, "_get_jwk_client", lambda: fake)


def _make_token(
    rsa_key,
    *,
    aud=f"api://{TEST_CLIENT_ID}",
    iss=VALID_ISS,
    oid="entra-oid-abc",
    sub="entra-sub-abc",
    name="山田 花子",
    scp="access_as_user",
    exp_delta_sec=600,
    tid=VALID_TID,
) -> str:
    """テスト用の署名済み JWT（RS256）を作る。"""
    now = datetime.now(tz=timezone.utc)
    payload = {
        "aud": aud,
        "iss": iss,
        "iat": now,
        "nbf": now,
        "exp": now + dt.timedelta(seconds=exp_delta_sec),
        "tid": tid,
    }
    if oid is not None:
        payload["oid"] = oid
    if sub is not None:
        payload["sub"] = sub
    if name is not None:
        payload["name"] = name
    if scp is not None:
        payload["scp"] = scp
    return jwt.encode(payload, rsa_key, algorithm="RS256")


def test_verify_ok(rsa_key):
    """正常なトークンは検証成功し、oid が auth_id・name が取得される。"""
    token = _make_token(rsa_key)
    claims = entra.verify_entra_token(token, TEST_CLIENT_ID)
    assert claims.auth_id == "entra-oid-abc"
    assert claims.name == "山田 花子"
    assert claims.tid == VALID_TID


def test_verify_aud_bare_client_id(rsa_key):
    """aud が素の client_id（api:// なし）でも許容される。"""
    token = _make_token(rsa_key, aud=TEST_CLIENT_ID)
    claims = entra.verify_entra_token(token, TEST_CLIENT_ID)
    assert claims.auth_id == "entra-oid-abc"


def test_verify_expired(rsa_key):
    """期限切れトークンは EntraTokenError。"""
    token = _make_token(rsa_key, exp_delta_sec=-10)
    with pytest.raises(entra.EntraTokenError):
        entra.verify_entra_token(token, TEST_CLIENT_ID)


def test_verify_wrong_aud(rsa_key):
    """aud 不一致は EntraTokenError。"""
    token = _make_token(rsa_key, aud="api://someone-else")
    with pytest.raises(entra.EntraTokenError):
        entra.verify_entra_token(token, TEST_CLIENT_ID)


def test_verify_tampered_signature(rsa_key):
    """改ざん（別鍵で署名）は署名検証で EntraTokenError。"""
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(tz=timezone.utc)
    token = jwt.encode(
        {
            "aud": f"api://{TEST_CLIENT_ID}",
            "iss": VALID_ISS,
            "exp": now + dt.timedelta(seconds=600),
            "oid": "entra-oid-abc",
            "scp": "access_as_user",
        },
        other_key,  # モック JWKS の公開鍵とは対にならない別鍵
        algorithm="RS256",
    )
    with pytest.raises(entra.EntraTokenError):
        entra.verify_entra_token(token, TEST_CLIENT_ID)


def test_verify_bad_issuer(rsa_key):
    """iss が想定形式でない（別プロバイダ偽装）は EntraTokenError。"""
    token = _make_token(rsa_key, iss="https://evil.example.com/tenant/v2.0")
    with pytest.raises(entra.EntraTokenError):
        entra.verify_entra_token(token, TEST_CLIENT_ID)


def test_verify_missing_scope(rsa_key):
    """scp が存在するが access_as_user を含まない場合は EntraTokenError。"""
    token = _make_token(rsa_key, scp="openid profile")
    with pytest.raises(entra.EntraTokenError):
        entra.verify_entra_token(token, TEST_CLIENT_ID)


def test_verify_scope_absent_is_ok(rsa_key):
    """scp が存在しないトークンは（scp 確認をスキップして）通す。"""
    token = _make_token(rsa_key, scp=None)
    claims = entra.verify_entra_token(token, TEST_CLIENT_ID)
    assert claims.auth_id == "entra-oid-abc"


def test_verify_oid_absent_falls_back_to_sub(rsa_key):
    """oid が無ければ sub を auth_id に使う。"""
    token = _make_token(rsa_key, oid=None, sub="entra-sub-only")
    claims = entra.verify_entra_token(token, TEST_CLIENT_ID)
    assert claims.auth_id == "entra-sub-only"


# --- 2. 自動プロビジョニング＋dev トークン併存（require_family 経由） -----------


@pytest.fixture
def entra_enabled(monkeypatch):
    """ENTRA_CLIENT_ID を設定し、get_settings のキャッシュをクリアする。

    settings は lru_cache のため、環境変数変更後にキャッシュを落とす必要がある。
    """
    monkeypatch.setenv("ENTRA_CLIENT_ID", TEST_CLIENT_ID)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_provisioning_creates_family_and_owner(client, entra_enabled, rsa_key, db):
    """初回 Entra ログインで家族＋owner が自動作成され、albums にアクセスできる。"""
    from app.db.models import Family, User

    token = _make_token(rsa_key, oid="oid-new-user", name="佐藤")
    res = client.get("/albums", headers=_bearer(token))
    assert res.status_code == 200
    assert res.json()["items"] == []

    # 家族＋owner が作られた（家族名は「{name}の家族」・auth_id は entra: プレフィックス付き）。
    user = db.query(User).filter(User.auth_id == "entra:oid-new-user").one()
    assert user.role == "owner"
    family = db.query(Family).filter(Family.id == user.family_id).one()
    assert family.name == "佐藤の家族"


def test_provisioning_is_idempotent(client, entra_enabled, rsa_key, db):
    """同一 auth_id の2回目のログインは同じ家族に解決される（重複作成しない）。"""
    from app.db.models import Family, User

    token = _make_token(rsa_key, oid="oid-repeat")
    client.get("/albums", headers=_bearer(token))
    client.get("/albums", headers=_bearer(token))

    users = db.query(User).filter(User.auth_id == "entra:oid-repeat").all()
    assert len(users) == 1
    families = db.query(Family).all()
    assert len(families) == 1


def test_provisioning_name_absent_defaults(client, entra_enabled, rsa_key, db):
    """表示名（name）が無い場合、家族名は「わたしの家族」になる。"""
    from app.db.models import Family, User

    token = _make_token(rsa_key, oid="oid-noname", name=None)
    client.get("/albums", headers=_bearer(token))
    user = db.query(User).filter(User.auth_id == "entra:oid-noname").one()
    family = db.query(Family).filter(Family.id == user.family_id).one()
    assert family.name == "わたしの家族"


def test_dev_token_still_works_when_entra_enabled(
    client, entra_enabled, seeded, family_headers
):
    """Entra 有効時も dev トークンは併存して動く（テスト家族の裏口）。"""
    res = client.get("/albums", headers=family_headers)
    assert res.status_code == 200


def test_entra_invalid_token_401_when_enabled(client, entra_enabled, rsa_key):
    """Entra 有効時、無効な Entra トークンは 401（改ざん）。"""
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(tz=timezone.utc)
    token = jwt.encode(
        {
            "aud": f"api://{TEST_CLIENT_ID}",
            "iss": VALID_ISS,
            "exp": now + dt.timedelta(seconds=600),
            "oid": "x",
        },
        other_key,
        algorithm="RS256",
    )
    res = client.get("/albums", headers=_bearer(token))
    assert res.status_code == 401


def test_non_dev_bearer_401_when_entra_disabled(client, seeded):
    """Entra 無効（ENTRA_CLIENT_ID 空）時、dev トークン以外の Bearer は 401。

    entra_enabled フィクスチャを使わない＝conftest の既定（空）のまま。
    """
    get_settings.cache_clear()
    res = client.get("/albums", headers=_bearer("some-random-jwt-like-token"))
    assert res.status_code == 401
    get_settings.cache_clear()


# --- 3. 分離テスト（他人のアルバムが見えない） ---------------------------------


def _seed_album_for(db, family_id, device_id, channel: str) -> Album:
    """指定家族に ready アルバムを1件作る。"""
    call = Call(
        family_id=family_id,
        device_id=device_id,
        channel_name=channel,
        status="ended",
    )
    db.add(call)
    db.flush()
    mems = []
    for _ in range(5):
        m = Memory(
            call_id=call.id,
            type="photo",
            storage_key=f"families/{family_id}/calls/{call.id}/candidates/{uuid4()}.jpg",
            status="selected",
            captured_at=datetime.now(timezone.utc),
            meta_={},
        )
        db.add(m)
        mems.append(m)
    db.flush()
    album = Album(
        call_id=call.id,
        status="ready",
        selected_memory_ids=[str(m.id) for m in mems],
        version=1,
        video_storage_key=f"families/{family_id}/calls/{call.id}/albums/v1.mp4",
        confirmed_at=datetime.now(timezone.utc),
    )
    db.add(album)
    db.commit()
    return album


def test_entra_users_are_isolated(client, entra_enabled, rsa_key, db, seeded):
    """他人（別 auth_id）の Entra トークンでは他人の家族のアルバムが見えない。

    - seeded の家族（A）に ready アルバムを1件作る。
    - Entra ユーザー B が初回ログイン（別家族が自動作成される）。
    - B の GET /albums は空（A のアルバムは見えない）。
    - dev トークン（A の owner）では A のアルバムが1件見える。
    """
    # A（seeded 家族）にアルバムを作る。
    _seed_album_for(db, seeded["family_id"], seeded["device_id"], "ch-familyA")

    # B（Entra 新規ユーザー）でログイン → 自分の家族が作られる。
    token_b = _make_token(rsa_key, oid="oid-user-B", name="B")
    res_b = client.get("/albums", headers=_bearer(token_b))
    assert res_b.status_code == 200
    assert res_b.json()["items"] == []  # A のアルバムは見えない

    # A（dev トークン＝A の owner）では自分のアルバムが1件見える。
    res_a = client.get(
        "/albums", headers={"Authorization": "Bearer dev-fixed-token"}
    )
    assert res_a.status_code == 200
    assert len(res_a.json()["items"]) == 1
