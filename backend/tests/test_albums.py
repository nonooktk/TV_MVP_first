"""albums 一覧・latest のテスト。"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from app.db.models import Album, Call


def _ready_album(db, seeded, version=1) -> Album:
    call = Call(
        family_id=seeded["family_id"],
        device_id=seeded["device_id"],
        channel_name="ch-albumtest0",
        status="ended",
    )
    db.add(call)
    db.flush()
    album = Album(
        call_id=call.id,
        status="ready",
        selected_memory_ids=[str(uuid4()) for _ in range(5)],
        version=version,
        video_storage_key=f"families/x/calls/{call.id}/albums/v{version}.mp4",
        confirmed_at=datetime.now(timezone.utc),
    )
    db.add(album)
    db.commit()
    db.refresh(album)
    return album


def test_albums_list_only_ready(client, seeded, db, family_headers):
    """ready のアルバムのみ一覧に出る。"""
    _ready_album(db, seeded)
    # awaiting_selection のアルバムは出ない
    call2 = Call(
        family_id=seeded["family_id"],
        device_id=seeded["device_id"],
        channel_name="ch-notready00",
        status="ended",
    )
    db.add(call2)
    db.flush()
    db.add(Album(call_id=call2.id, status="awaiting_selection"))
    db.commit()

    res = client.get("/albums", headers=family_headers)
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["status"] == "ready"
    assert items[0]["video_sas_url"]


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
