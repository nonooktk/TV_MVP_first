"""Google アカウント認証（家族側ログインのマルチプロバイダ化）の検証・分離テスト。

Entra のテスト（test_entra_auth.py）と対称の3レイヤー:

1. JWT 検証ロジック（app.core.google.verify_google_token）を、自前の RSA 鍵で署名した
   トークン＋モックした JWKS で検証する（正常・aud不一致・iss不正・期限切れ・改ざん・sub欠落）。
2. プレフィックス付きプロビジョニング（require_family 経由）: 未知の sub で家族＋owner が
   `google:{sub}` として作られ、2回目は同一家族に解決される。dev トークン併存の回帰も確認。
3. 分離: プロバイダ間（Google と Entra）・他人間（別 sub）で家族スコープが分かれる。

いずれも GOOGLE_CLIENT_ID を設定した状態でのみ有効。署名検証はモック鍵に差し替えるため、
実 Google への通信は行わない。
"""

from __future__ import annotations

import datetime as dt
from datetime import datetime, timezone
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core import google
from app.core.config import get_settings
from app.db.models import Album, Call, Memory

TEST_GOOGLE_CLIENT_ID = (
    "1079731061136-b4qeaf52n55ukqhop8ft3khg6pmf67a2.apps.googleusercontent.com"
)
VALID_ISS = "https://accounts.google.com"


# --- 1. JWT 検証ロジックの単体テスト -------------------------------------------


@pytest.fixture
def rsa_key():
    """署名・検証に使う RSA 鍵ペア（テスト内で生成）。"""
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(autouse=True)
def _mock_jwks(monkeypatch, rsa_key):
    """PyJWKClient を差し替え、テスト鍵の公開鍵を署名鍵として返す（実 JWKS へ通信しない）。"""

    class _FakeSigningKey:
        def __init__(self, public_key):
            self.key = public_key

    class _FakeJWKClient:
        def __init__(self, public_key):
            self._public_key = public_key

        def get_signing_key_from_jwt(self, token):  # noqa: D102
            return _FakeSigningKey(self._public_key)

    fake = _FakeJWKClient(rsa_key.public_key())
    monkeypatch.setattr(google, "_get_jwk_client", lambda: fake)


def _make_token(
    rsa_key,
    *,
    aud=TEST_GOOGLE_CLIENT_ID,
    iss=VALID_ISS,
    sub="google-sub-abc",
    name="山田 花子",
    exp_delta_sec=600,
) -> str:
    """テスト用の署名済み Google ID トークン風 JWT（RS256）を作る。"""
    now = datetime.now(tz=timezone.utc)
    payload = {
        "aud": aud,
        "iss": iss,
        "iat": now,
        "exp": now + dt.timedelta(seconds=exp_delta_sec),
    }
    if sub is not None:
        payload["sub"] = sub
    if name is not None:
        payload["name"] = name
    return jwt.encode(payload, rsa_key, algorithm="RS256")


def test_verify_ok(rsa_key):
    """正常なトークンは検証成功し、sub が取得される。"""
    token = _make_token(rsa_key)
    claims = google.verify_google_token(token, TEST_GOOGLE_CLIENT_ID)
    assert claims.sub == "google-sub-abc"
    assert claims.name == "山田 花子"


def test_verify_iss_bare_domain_ok(rsa_key):
    """iss が `accounts.google.com`（スキームなし）でも許容される。"""
    token = _make_token(rsa_key, iss="accounts.google.com")
    claims = google.verify_google_token(token, TEST_GOOGLE_CLIENT_ID)
    assert claims.sub == "google-sub-abc"


def test_verify_wrong_aud(rsa_key):
    """aud 不一致は GoogleTokenError。"""
    token = _make_token(rsa_key, aud="other-client-id.apps.googleusercontent.com")
    with pytest.raises(google.GoogleTokenError):
        google.verify_google_token(token, TEST_GOOGLE_CLIENT_ID)


def test_verify_bad_issuer(rsa_key):
    """iss が Google でない（別プロバイダ偽装）は GoogleTokenError。"""
    token = _make_token(rsa_key, iss="https://evil.example.com")
    with pytest.raises(google.GoogleTokenError):
        google.verify_google_token(token, TEST_GOOGLE_CLIENT_ID)


def test_verify_expired(rsa_key):
    """期限切れトークンは GoogleTokenError。"""
    token = _make_token(rsa_key, exp_delta_sec=-10)
    with pytest.raises(google.GoogleTokenError):
        google.verify_google_token(token, TEST_GOOGLE_CLIENT_ID)


def test_verify_tampered_signature(rsa_key):
    """改ざん（別鍵で署名）は署名検証で GoogleTokenError。"""
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(tz=timezone.utc)
    token = jwt.encode(
        {
            "aud": TEST_GOOGLE_CLIENT_ID,
            "iss": VALID_ISS,
            "exp": now + dt.timedelta(seconds=600),
            "sub": "google-sub-abc",
        },
        other_key,  # モック JWKS の公開鍵とは対にならない別鍵
        algorithm="RS256",
    )
    with pytest.raises(google.GoogleTokenError):
        google.verify_google_token(token, TEST_GOOGLE_CLIENT_ID)


def test_verify_missing_sub(rsa_key):
    """sub が無いトークンは GoogleTokenError。"""
    token = _make_token(rsa_key, sub=None)
    with pytest.raises(google.GoogleTokenError):
        google.verify_google_token(token, TEST_GOOGLE_CLIENT_ID)


# --- 2. プレフィックス付きプロビジョニング＋dev 併存（require_family 経由） -----


@pytest.fixture
def google_enabled(monkeypatch):
    """GOOGLE_CLIENT_ID を設定し、get_settings のキャッシュをクリアする。"""
    monkeypatch.setenv("GOOGLE_CLIENT_ID", TEST_GOOGLE_CLIENT_ID)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_provisioning_creates_family_with_google_prefix(
    client, google_enabled, rsa_key, db
):
    """初回 Google ログインで家族＋owner が `google:{sub}` として自動作成される。"""
    from app.db.models import Family, User

    token = _make_token(rsa_key, sub="sub-new-user", name="佐藤")
    res = client.get("/albums", headers=_bearer(token))
    assert res.status_code == 200
    assert res.json()["items"] == []

    # auth_id は google: プレフィックス付き。
    user = db.query(User).filter(User.auth_id == "google:sub-new-user").one()
    assert user.role == "owner"
    family = db.query(Family).filter(Family.id == user.family_id).one()
    assert family.name == "佐藤の家族"


def test_provisioning_is_idempotent(client, google_enabled, rsa_key, db):
    """同一 sub の2回目のログインは同じ家族に解決される（重複作成しない）。"""
    from app.db.models import Family, User

    token = _make_token(rsa_key, sub="sub-repeat")
    client.get("/albums", headers=_bearer(token))
    client.get("/albums", headers=_bearer(token))

    users = db.query(User).filter(User.auth_id == "google:sub-repeat").all()
    assert len(users) == 1
    families = db.query(Family).all()
    assert len(families) == 1


def test_dev_token_still_works_when_google_enabled(
    client, google_enabled, seeded, family_headers
):
    """Google 有効時も dev トークンは併存して動く（テスト家族の裏口）。"""
    res = client.get("/albums", headers=family_headers)
    assert res.status_code == 200


def test_google_invalid_token_401_when_enabled(client, google_enabled, rsa_key):
    """Google 有効時、改ざんされた Google トークンは 401。"""
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(tz=timezone.utc)
    token = jwt.encode(
        {
            "aud": TEST_GOOGLE_CLIENT_ID,
            "iss": VALID_ISS,
            "exp": now + dt.timedelta(seconds=600),
            "sub": "x",
        },
        other_key,
        algorithm="RS256",
    )
    res = client.get("/albums", headers=_bearer(token))
    assert res.status_code == 401


def test_google_token_401_when_disabled(client, seeded, rsa_key):
    """Google 無効（GOOGLE_CLIENT_ID 空）時、Google iss の Bearer は 401。

    google_enabled フィクスチャを使わない＝conftest の既定（空）のまま。
    """
    get_settings.cache_clear()
    token = _make_token(rsa_key, sub="sub-when-disabled")
    res = client.get("/albums", headers=_bearer(token))
    assert res.status_code == 401
    get_settings.cache_clear()


# --- 3. 分離テスト（プロバイダ間・他人間） -------------------------------------


def _seed_album_for(db, family_id, owner_user_id, channel: str) -> Album:
    """指定家族に device＋ready アルバムを1件作る。"""
    from app.db.models import Device

    device = Device(
        family_id=family_id,
        fixed_contact_user_id=owner_user_id,
        device_token_hash=f"hash-{uuid4()}",
        status="active",
    )
    db.add(device)
    db.flush()
    call = Call(
        family_id=family_id,
        device_id=device.id,
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


def test_google_users_are_isolated_from_each_other(
    client, google_enabled, rsa_key, db
):
    """別 sub の Google ユーザー同士で家族スコープが分かれる（他人のアルバムが見えない）。"""
    # ユーザー A が初回ログイン → アルバム1件を持つ。
    token_a = _make_token(rsa_key, sub="sub-A", name="A")
    client.get("/albums", headers=_bearer(token_a))
    from app.db.models import User

    user_a = db.query(User).filter(User.auth_id == "google:sub-A").one()
    _seed_album_for(db, user_a.family_id, user_a.id, "ch-googleA")

    # A には自分のアルバムが1件見える。
    res_a = client.get("/albums", headers=_bearer(token_a))
    assert len(res_a.json()["items"]) == 1

    # ユーザー B（別 sub）は空（A のアルバムは見えない）。
    token_b = _make_token(rsa_key, sub="sub-B", name="B")
    res_b = client.get("/albums", headers=_bearer(token_b))
    assert res_b.status_code == 200
    assert res_b.json()["items"] == []


def test_google_and_entra_same_subject_are_separate(
    client, monkeypatch, rsa_key, db
):
    """Google と Entra で「同じ主体文字列」でも別家族に分離される（プレフィックス方式の要）。

    Google と Entra の両方を有効化し、同じ生の主体 ID "shared-subject" を持つトークンで
    それぞれログインすると、`google:shared-subject` と `entra:shared-subject` の別ユーザー
    （別家族）が作られることを確認する。
    """
    from app.core import entra as entra_mod
    from app.db.models import User

    # 両プロバイダを有効化。
    monkeypatch.setenv("GOOGLE_CLIENT_ID", TEST_GOOGLE_CLIENT_ID)
    entra_client_id = "11111111-2222-3333-4444-555555555555"
    monkeypatch.setenv("ENTRA_CLIENT_ID", entra_client_id)
    get_settings.cache_clear()

    # Entra 検証器も同じテスト鍵の JWKS に差し替える（_mock_jwks は google のみ差し替え済み）。
    class _FakeSigningKey:
        def __init__(self, public_key):
            self.key = public_key

    class _FakeJWKClient:
        def __init__(self, public_key):
            self._public_key = public_key

        def get_signing_key_from_jwt(self, token):
            return _FakeSigningKey(self._public_key)

    monkeypatch.setattr(
        entra_mod, "_get_jwk_client", lambda: _FakeJWKClient(rsa_key.public_key())
    )

    # Google トークン（sub=shared-subject）でログイン。
    g_token = _make_token(rsa_key, sub="shared-subject", name="Gさん")
    assert client.get("/albums", headers=_bearer(g_token)).status_code == 200

    # Entra トークン（oid=shared-subject）でログイン。
    now = datetime.now(tz=timezone.utc)
    entra_iss = (
        "https://login.microsoftonline.com/"
        "9188040d-6c67-4c5b-b112-36a304b66dad/v2.0"
    )
    e_token = jwt.encode(
        {
            "aud": f"api://{entra_client_id}",
            "iss": entra_iss,
            "exp": now + dt.timedelta(seconds=600),
            "oid": "shared-subject",
            "name": "Eさん",
            "scp": "access_as_user",
        },
        rsa_key,
        algorithm="RS256",
    )
    assert client.get("/albums", headers=_bearer(e_token)).status_code == 200

    # 別々のユーザー（別家族）が作られている。
    g_user = db.query(User).filter(User.auth_id == "google:shared-subject").one()
    e_user = db.query(User).filter(User.auth_id == "entra:shared-subject").one()
    assert g_user.family_id != e_user.family_id

    get_settings.cache_clear()
