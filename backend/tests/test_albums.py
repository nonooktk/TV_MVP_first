"""albums 一覧・latest・削除のテスト。"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from app.api.deps import require_family
from app.db.models import Album, Call, Memory, User
from app.main import app


def _make_call(db, seeded, channel="ch-albumtest0") -> Call:
    call = Call(
        family_id=seeded["family_id"],
        device_id=seeded["device_id"],
        channel_name=channel,
        status="ended",
    )
    db.add(call)
    db.flush()
    return call


def _add_photos(db, call, n=5) -> list[Memory]:
    mems: list[Memory] = []
    for i in range(n):
        m = Memory(
            call_id=call.id,
            type="photo",
            storage_key=f"families/x/calls/{call.id}/candidates/{uuid4()}.jpg",
            status="selected",
            captured_at=datetime.now(timezone.utc),
            meta_={},
        )
        db.add(m)
        mems.append(m)
    db.flush()
    return mems


def _ready_album(db, seeded, version=1, with_memories=True, collage=False) -> Album:
    call = _make_call(db, seeded, channel=f"ch-{uuid4().hex[:10]}")
    if with_memories:
        mems = _add_photos(db, call, 5)
        selected = [str(m.id) for m in mems]
    else:
        selected = [str(uuid4()) for _ in range(5)]
    album = Album(
        call_id=call.id,
        status="ready",
        selected_memory_ids=selected,
        version=version,
        video_storage_key=f"families/x/calls/{call.id}/albums/v{version}.mp4",
        collage_storage_key=(
            f"families/x/calls/{call.id}/albums/collage_v{version}.jpg"
            if collage
            else None
        ),
        confirmed_at=datetime.now(timezone.utc),
    )
    db.add(album)
    db.commit()
    db.refresh(album)
    return album


def test_albums_list_includes_all_statuses(client, seeded, db, family_headers):
    """status=all（既定）で awaiting_selection / generating / ready をすべて返す。"""
    _ready_album(db, seeded)
    # awaiting_selection のアルバムも出る（契約変更 v0.5.0）。
    call2 = _make_call(db, seeded, channel="ch-notready00")
    db.add(Album(call_id=call2.id, status="awaiting_selection"))
    db.commit()

    res = client.get("/albums", headers=family_headers)
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 2
    statuses = {it["status"] for it in items}
    assert statuses == {"ready", "awaiting_selection"}


def test_albums_list_status_filter(client, seeded, db, family_headers):
    """status=ready で ready のみに絞れる。"""
    _ready_album(db, seeded)
    call2 = _make_call(db, seeded, channel="ch-await00000")
    db.add(Album(call_id=call2.id, status="awaiting_selection"))
    db.commit()

    res = client.get("/albums?status=ready", headers=family_headers)
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["status"] == "ready"
    assert items[0]["video_sas_url"]


def test_albums_list_invalid_status(client, seeded, family_headers):
    """不正な status は 400。"""
    res = client.get("/albums?status=bogus", headers=family_headers)
    assert res.status_code == 400


def test_albums_list_photos_and_collage(client, seeded, db, family_headers):
    """ready の要素は確定5枚 photos と collage_sas_url を含む。"""
    _ready_album(db, seeded, with_memories=True, collage=True)
    res = client.get("/albums?status=ready", headers=family_headers)
    assert res.status_code == 200
    item = res.json()["items"][0]
    assert item["collage_sas_url"]
    assert len(item["photos"]) == 5
    photo = item["photos"][0]
    assert photo["memory_id"]
    assert photo["sas_url"]
    assert photo["thumb_sas_url"]  # パス規約から導出（存在チェックなし）
    assert photo["captured_at"]


def test_albums_list_awaiting_has_empty_photos(client, seeded, db, family_headers):
    """awaiting_selection は photos が空配列・collage_sas_url は null。"""
    call = _make_call(db, seeded, channel="ch-await11111")
    db.add(Album(call_id=call.id, status="awaiting_selection"))
    db.commit()
    res = client.get("/albums?status=awaiting_selection", headers=family_headers)
    item = res.json()["items"][0]
    assert item["photos"] == []
    assert item["collage_sas_url"] is None


def test_albums_pagination(client, seeded, db, family_headers):
    """limit/cursor でページングできる。"""
    for _ in range(3):
        _ready_album(db, seeded)
    page1 = client.get("/albums?limit=2", headers=family_headers).json()
    assert len(page1["items"]) == 2
    assert page1["next_cursor"] is not None
    page2 = client.get(
        f"/albums?limit=2&cursor={page1['next_cursor']}", headers=family_headers
    ).json()
    assert len(page2["items"]) == 1
    assert page2["next_cursor"] is None


def test_albums_latest_device(client, seeded, db, device_headers):
    """latest がデバイス向けに最新 ready を返す。"""
    _ready_album(db, seeded, version=1)
    res = client.get("/albums/latest", headers=device_headers)
    assert res.status_code == 200
    assert res.json()["status"] == "ready"
    assert res.json()["video_sas_url"]


def test_albums_latest_404_when_none(client, seeded, device_headers):
    """ready が無ければ latest は 404。"""
    res = client.get("/albums/latest", headers=device_headers)
    assert res.status_code == 404


# --- DELETE /albums/{album_id} ------------------------------------------------


def _seed_album_blobs(fake_blob, seeded, album, mems):
    """削除検証用に、この album に対応する Blob を Fake Blob へ事前投入する。"""
    fam = seeded["family_id"]
    call_id = album.call_id
    prefix = f"families/{fam}/calls/{call_id}/"
    # 動画（v1, v2）・コラージュ・candidates・thumbs・snippets を投入。
    fake_blob.store.add(f"{prefix}albums/v1.mp4")
    fake_blob.store.add(f"{prefix}albums/v2.mp4")
    fake_blob.store.add(f"{prefix}albums/collage_v2.jpg")
    fake_blob.store.add(f"{prefix}snippets/keepme.webm")  # 残るべき
    for m in mems:
        fake_blob.store.add(m.storage_key)
        fake_blob.store.add(f"{prefix}thumbs/{m.id}.jpg")


def _owner_album_with_blobs(db, seeded, fake_blob):
    """owner 家族の ready アルバム＋対応 Blob を用意して返す。"""
    call = _make_call(db, seeded, channel=f"ch-{uuid4().hex[:10]}")
    mems = _add_photos(db, call, 5)
    album = Album(
        call_id=call.id,
        status="ready",
        selected_memory_ids=[str(m.id) for m in mems],
        version=2,
        video_storage_key=f"families/{seeded['family_id']}/calls/{call.id}/albums/v2.mp4",
        collage_storage_key=f"families/{seeded['family_id']}/calls/{call.id}/albums/collage_v2.jpg",
        confirmed_at=datetime.now(timezone.utc),
    )
    db.add(album)
    db.commit()
    db.refresh(album)
    _seed_album_blobs(fake_blob, seeded, album, mems)
    return call, album, mems


def test_delete_album_owner_204(client, seeded, db, family_headers, fake_blob):
    """owner が削除すると 204・album 行と memories 行が消える。"""
    call, album, mems = _owner_album_with_blobs(db, seeded, fake_blob)
    album_id = album.id
    mem_ids = [m.id for m in mems]

    res = client.delete(f"/albums/{album_id}", headers=family_headers)
    assert res.status_code == 204

    db.expire_all()
    assert db.get(Album, album_id) is None
    for mid in mem_ids:
        assert db.get(Memory, mid) is None
    # call 行は残る。
    assert db.get(Call, call.id) is not None


def test_delete_album_deletes_blobs(client, seeded, db, family_headers, fake_blob):
    """削除で 動画全版・コラージュ・candidates・thumbs の Blob が消え、snippets は残る。"""
    call, album, mems = _owner_album_with_blobs(db, seeded, fake_blob)
    prefix = f"families/{seeded['family_id']}/calls/{call.id}/"

    res = client.delete(f"/albums/{album.id}", headers=family_headers)
    assert res.status_code == 204

    # 動画 v1/v2・コラージュ・各 candidates・thumbs が store から消える。
    assert f"{prefix}albums/v1.mp4" not in fake_blob.store
    assert f"{prefix}albums/v2.mp4" not in fake_blob.store
    assert f"{prefix}albums/collage_v2.jpg" not in fake_blob.store
    for m in mems:
        assert m.storage_key not in fake_blob.store
        assert f"{prefix}thumbs/{m.id}.jpg" not in fake_blob.store
    # snippets は残す。
    assert f"{prefix}snippets/keepme.webm" in fake_blob.store
    # 動画・コラージュの削除呼び出しが行われている。
    assert any(k.endswith("albums/v1.mp4") for k in fake_blob.deleted)
    assert any("collage_v2.jpg" in k for k in fake_blob.deleted)


def test_delete_album_idempotent_missing_blobs(client, seeded, db, family_headers, fake_blob):
    """Blob が存在しなくても（未投入）削除は 204 で成功する（冪等）。"""
    call = _make_call(db, seeded, channel="ch-nobl000000")
    mems = _add_photos(db, call, 5)
    album = Album(
        call_id=call.id,
        status="ready",
        selected_memory_ids=[str(m.id) for m in mems],
        version=1,
        confirmed_at=datetime.now(timezone.utc),
    )
    db.add(album)
    db.commit()
    album_id = album.id
    # fake_blob.store は空（Blob 無し）。
    res = client.delete(f"/albums/{album_id}", headers=family_headers)
    assert res.status_code == 204
    db.expire_all()
    assert db.get(Album, album_id) is None


def test_delete_album_viewer_403(client, seeded, db, fake_blob):
    """viewer ロールは 403（削除不可）。"""
    call, album, mems = _owner_album_with_blobs(db, seeded, fake_blob)

    # require_family を viewer ユーザーへ差し替える（role/family_id のみ参照される）。
    fam_id = seeded["family_id"]

    def _as_viewer():
        return User(id=uuid4(), family_id=fam_id, role="viewer", auth_id="dev-viewer")

    app.dependency_overrides[require_family] = _as_viewer
    try:
        res = client.delete(
            f"/albums/{album.id}", headers={"Authorization": "Bearer dev-fixed-token"}
        )
    finally:
        app.dependency_overrides.pop(require_family, None)
    assert res.status_code == 403
    # album 行は残る（削除されていない）。
    db.expire_all()
    assert db.get(Album, album.id) is not None


def test_delete_album_404_foreign(client, seeded, db, family_headers, fake_blob):
    """存在しない album は 404。"""
    res = client.delete(f"/albums/{uuid4()}", headers=family_headers)
    assert res.status_code == 404
