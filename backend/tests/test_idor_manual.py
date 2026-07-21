"""手動 IDOR 相当の自動ハーネス（家族Bとして家族Aのリソースを直叩き）。

メンター提示の「アカウントA/Bを作り、Bのトークンで A の album_id/call_id を叩く」を、
pytest の require_family 差し替えで忠実かつ再現可能に検証する。ローカル専用
（本番DBは対象にしない）。

- 家族A: 既存 `seeded` フィクスチャ（owner＋device）。A 保有の call/album/memory を用意する。
- 家族B: 別家族を作り、その owner としてなりすます（require_family を override）。
- 判定: すべて 401 / 403 / 404 なら OK。200（他家族データの取得・変更）が出たら Blocker。

参照: docs/SECURITY_CHECKLIST.md §6（手動 IDOR）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest

from app.api.deps import require_family
from app.core.config import get_settings
from app.db.models import Album, Call, Family, Memory, User
from app.main import app

# conftest の開発用固定トークン（family_headers と同値）。
from tests.conftest import FAMILY_TOKEN


# --- 家族A（seeded）が保有するリソースを用意する ------------------------------


def _make_owned_call(db, seeded) -> Call:
    call = Call(
        family_id=seeded["family_id"],
        device_id=seeded["device_id"],
        channel_name=f"ch-{uuid4().hex[:10]}",
        status="ended",
    )
    db.add(call)
    db.flush()
    return call


def _add_photos(db, call, n=5) -> list[Memory]:
    mems: list[Memory] = []
    for _ in range(n):
        m = Memory(
            call_id=call.id,
            type="photo",
            storage_key=f"families/{call.family_id}/calls/{call.id}/candidates/{uuid4()}.jpg",
            status="selected",
            captured_at=datetime.now(timezone.utc),
            meta_={},
        )
        db.add(m)
        mems.append(m)
    db.flush()
    return mems


def _ready_album_a(db, seeded) -> tuple[Call, Album, list[Memory]]:
    """家族A の ready アルバム（call＋album＋photo5枚）を作って返す。"""
    call = _make_owned_call(db, seeded)
    mems = _add_photos(db, call, 5)
    album = Album(
        call_id=call.id,
        status="ready",
        selected_memory_ids=[str(m.id) for m in mems],
        version=1,
        video_storage_key=f"families/{seeded['family_id']}/calls/{call.id}/albums/v1.mp4",
        confirmed_at=datetime.now(timezone.utc),
    )
    db.add(album)
    db.commit()
    db.refresh(album)
    return call, album, mems


# --- 家族B（別家族）を用意し、その owner/viewer になりすます override -----------


def _make_family_b(db) -> Family:
    fam = Family(name="家族B（IDORテスト）")
    db.add(fam)
    db.flush()  # fam.id を採番してから owner を作る（seeded と同じ順序）。
    db.add(User(family_id=fam.id, role="owner", auth_id="idor-b-owner"))
    db.commit()
    return fam


def _as_family_b(family_id, role="owner"):
    """require_family を「家族B の指定ロール」に差し替える override を返す。

    ルーターは user.family_id / user.role のみ参照するため、非永続の User で足りる
    （既存の viewer 差し替えテストと同じ手法）。
    """

    def _override() -> User:
        return User(id=uuid4(), family_id=family_id, role=role, auth_id="idor-b")

    return _override


# --- 正常系ベースライン（A→A は 200 で見える）--------------------------------


def test_baseline_owner_can_read_own_candidates(client, seeded, db, family_headers):
    """A 自身は自分の候補を 200 で取得できる（IDOR 検証の対照）。"""
    call, _album, _ = _ready_album_a(db, seeded)
    res = client.get(f"/calls/{call.id}/candidates", headers=family_headers)
    assert res.status_code == 200, res.text


# --- ① B → A の候補一覧を覗けるか（期待 404）---------------------------------


def test_idor_candidates_blocked(client, seeded, db):
    call, _album, _ = _ready_album_a(db, seeded)
    fam_b = _make_family_b(db)
    app.dependency_overrides[require_family] = _as_family_b(fam_b.id)
    res = client.get(f"/calls/{call.id}/candidates")
    assert res.status_code == 404, f"IDOR: 他家族が候補を取得できた: {res.text}"


# --- ② B → A のアルバム削除（期待 404。owner でも他家族は不可）--------------


def test_idor_delete_album_blocked_owner(client, seeded, db, fake_blob):
    _call, album, _ = _ready_album_a(db, seeded)
    fam_b = _make_family_b(db)
    app.dependency_overrides[require_family] = _as_family_b(fam_b.id, role="owner")
    res = client.delete(f"/albums/{album.id}")
    assert res.status_code == 404, f"IDOR: 他家族の owner がアルバムを削除できた: {res.text}"


def test_idor_delete_album_blocked_viewer(client, seeded, db, fake_blob):
    """viewer は role で 403、owner は帰属で 404。いずれも 204 でなければ安全。"""
    _call, album, _ = _ready_album_a(db, seeded)
    fam_b = _make_family_b(db)
    app.dependency_overrides[require_family] = _as_family_b(fam_b.id, role="viewer")
    res = client.delete(f"/albums/{album.id}")
    assert res.status_code in (403, 404), f"IDOR: 他家族 viewer が削除できた: {res.text}"


# --- ③ B → A の選択確定（期待 404）------------------------------------------


def test_idor_selection_blocked(client, seeded, db):
    call, _album, _ = _ready_album_a(db, seeded)
    fam_b = _make_family_b(db)
    app.dependency_overrides[require_family] = _as_family_b(fam_b.id)
    body = {"memory_ids": [str(uuid4()) for _ in range(5)]}
    res = client.post(f"/calls/{call.id}/selection", json=body)
    assert res.status_code == 404, f"IDOR: 他家族が選択確定を送れた: {res.text}"


# --- ④ B → A の通話へ upload-sas を要求（期待 404）--------------------------


def test_idor_upload_sas_blocked(client, seeded, db):
    call, _album, _ = _ready_album_a(db, seeded)
    fam_b = _make_family_b(db)
    app.dependency_overrides[require_family] = _as_family_b(fam_b.id)
    body = {"call_id": str(call.id), "filenames": ["evil.jpg"]}
    res = client.post("/media/upload-sas", json=body)
    assert res.status_code == 404, f"IDOR: 他家族が upload-sas を取得できた: {res.text}"


# --- F-10: register の storage_key 越境 read の芽を塞ぐ ------------------------


def test_register_rejects_foreign_prefix_storage_key(client, seeded, db, family_headers):
    """自分の call でも、他家族プレフィックスの storage_key は register できない（400）。

    許すと GET /calls/{id}/candidates が同 storage_key の read SAS を発行するため、
    他家族 Blob の read SAS を取得できる芽になる（F-1 の read 版・F-10）。
    """
    call = _make_owned_call(db, seeded)
    db.commit()
    other_family = uuid4()  # 家族A の call だが storage_key だけ別家族を指す
    payload = {
        "call_id": str(call.id),
        "items": [
            {
                "type": "photo",
                "storage_key": (
                    f"families/{other_family}/calls/{call.id}/candidates/evil.jpg"
                ),
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "metadata": {},
            }
        ],
    }
    res = client.post("/media/register", headers=family_headers, json=payload)
    assert res.status_code == 400, f"越境 storage_key の register が通った: {res.text}"


def test_register_rejects_traversal_storage_key(client, seeded, db, family_headers):
    """`..` を含む storage_key（プレフィックス配下からの遡上）も 400 で拒否する。"""
    call = _make_owned_call(db, seeded)
    db.commit()
    prefix = f"families/{call.family_id}/calls/{call.id}/"
    payload = {
        "call_id": str(call.id),
        "items": [
            {
                "type": "photo",
                "storage_key": f"{prefix}../../{uuid4()}/candidates/evil.jpg",
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "metadata": {},
            }
        ],
    }
    res = client.post("/media/register", headers=family_headers, json=payload)
    assert res.status_code == 400, f"'..' を含む storage_key の register が通った: {res.text}"


def test_register_accepts_own_prefix_storage_key(
    client, seeded, db, family_headers, fake_queue
):
    """自家族プレフィックス配下の storage_key は従来どおり 201 で登録できる（回帰）。"""
    call = _make_owned_call(db, seeded)
    db.commit()
    payload = {
        "call_id": str(call.id),
        "items": [
            {
                "type": "photo",
                "storage_key": (
                    f"families/{seeded['family_id']}/calls/{call.id}/candidates/ok.jpg"
                ),
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "metadata": {},
            }
        ],
    }
    res = client.post("/media/register", headers=family_headers, json=payload)
    assert res.status_code == 201, res.text
    assert len(res.json()["memory_ids"]) == 1


# --- 抜け道A: トークン未検証（ヘッダ差し替え）。無/空/不正 Bearer は 401 -----


@pytest.mark.parametrize(
    "authz",
    [None, "Bearer", "Bearer garbage", "Bearer null"],
)
def test_invalid_bearer_rejected(client, seeded, authz):
    """dev トークン・実プロバイダ以外の Bearer はすべて 401。"""
    headers = {} if authz is None else {"Authorization": authz}
    res = client.get("/albums", headers=headers)
    assert res.status_code == 401, f"不正 Bearer が通った: [{authz}] {res.text}"


def test_dev_token_backdoor_is_open_locally(client, seeded, family_headers):
    """dev 固定トークンはローカルでは通る（裏口）。本番相当では 401 であるべき（F-3）。

    この差分を記録に残すための対照テスト（ローカルでの 200 を明示する）。
    """
    res = client.get("/albums", headers=family_headers)
    assert res.status_code == 200, res.text
    assert FAMILY_TOKEN  # 参照（未使用 import 警告回避）


# --- F-3: DEV_FAMILY_TOKEN 空（本番相当）では dev トークン経路が無効 --------------


@pytest.mark.parametrize(
    "authz",
    [
        f"Bearer {FAMILY_TOKEN}",  # 旧 dev 固定トークン
        "Bearer ",  # 空文字トークン（空 env が裏口とマッチしないこと）
        "Bearer garbage",  # 不正 Bearer
        None,  # ヘッダ無し
    ],
)
def test_dev_token_disabled_when_env_empty(client, seeded, authz):
    """F-3: `DEV_FAMILY_TOKEN` を空にすると dev トークン経路が無効化され、すべて 401。

    本番は cloud の `ca-tvmvp-api` から DEV_FAMILY_TOKEN env を除去する運用。空文字トークンが
    `token == settings.DEV_FAMILY_TOKEN`（空同士）で裏口とマッチする穴を、コードガード
    （`settings.DEV_FAMILY_TOKEN and ...`）が塞いでいることを確認する。Google/Entra も未設定に
    上書きするため、正規トークン以外は全滅（＝プロバイダのみで認証する本番相当）。
    """
    base = get_settings()
    empty = base.model_copy(
        update={
            "DEV_FAMILY_TOKEN": "",
            "GOOGLE_CLIENT_ID": "",
            "ENTRA_CLIENT_ID": "",
        }
    )
    app.dependency_overrides[get_settings] = lambda: empty
    try:
        headers = {} if authz is None else {"Authorization": authz}
        res = client.get("/albums", headers=headers)
        assert res.status_code == 401, (
            f"DEV_FAMILY_TOKEN 空なのに通った: [{authz}] {res.text}"
        )
    finally:
        app.dependency_overrides.pop(get_settings, None)
