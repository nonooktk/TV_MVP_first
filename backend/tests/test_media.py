"""media/register でのキュー投函、upload-sas、candidates、selection のテスト。"""

from __future__ import annotations

from datetime import datetime, timezone

from app.db.models import Album, Call, Memory


def _make_call(db, seeded, status="ended") -> Call:
    call = Call(
        family_id=seeded["family_id"],
        device_id=seeded["device_id"],
        caller_user_id=seeded["owner_id"],
        channel_name="ch-test000000",
        status=status,
    )
    db.add(call)
    db.commit()
    db.refresh(call)
    return call


def test_media_register_creates_memories_and_enqueues(
    client, seeded, db, family_headers, fake_queue
):
    """media/register が memories を作成し score をキュー投函する。"""
    call = _make_call(db, seeded, status="active")
    payload = {
        "call_id": str(call.id),
        "items": [
            {
                "type": "photo",
                "storage_key": f"families/{seeded['family_id']}/calls/{call.id}/candidates/a.jpg",
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "metadata": {"trigger_reason": "rms"},
            },
            {
                "type": "audio",
                "storage_key": f"families/{seeded['family_id']}/calls/{call.id}/snippets/a.webm",
                "captured_at": datetime.now(timezone.utc).isoformat(),
            },
        ],
    }
    res = client.post("/media/register", headers=family_headers, json=payload)
    assert res.status_code == 201
    assert len(res.json()["memory_ids"]) == 2

    # score メッセージが1件投函される
    assert len(fake_queue.messages) == 1
    msg = fake_queue.messages[0]
    assert msg["job_type"] == "score"
    assert msg["call_id"] == str(call.id)
    assert msg["schema_version"] == 1

    # call が ended に更新される
    db.expire_all()
    updated = db.get(Call, call.id)
    assert updated.status == "ended"
    assert updated.ended_at is not None


def test_upload_sas(client, seeded, db, family_headers):
    """upload-sas が通話プレフィックス配下の書き込みURLを返す。"""
    call = _make_call(db, seeded)
    res = client.post(
        "/media/upload-sas",
        headers=family_headers,
        json={"call_id": str(call.id), "filenames": ["candidates/x.jpg", "snippets/x.webm"]},
    )
    assert res.status_code == 200
    body = res.json()
    assert len(body["items"]) == 2
    for item in body["items"]:
        assert item["storage_key"].startswith(
            f"families/{seeded['family_id']}/calls/{call.id}/"
        )
        assert "sig=upload" in item["upload_url"]


def _seed_candidates(db, call, n=6, presented=True) -> Album:
    """写真候補 n 枚＋album（awaiting_selection）を作る。"""
    for i in range(n):
        db.add(
            Memory(
                call_id=call.id,
                type="photo",
                storage_key=f"families/x/calls/{call.id}/candidates/{i}.jpg",
                score=float(i),  # score 昇順（rank1 は最高スコア=末尾iが最大）
                status="candidate",
                captured_at=datetime.now(timezone.utc),
                meta_={},
            )
        )
    album = Album(
        call_id=call.id,
        status="awaiting_selection",
        presented_at=datetime.now(timezone.utc) if presented else None,
    )
    db.add(album)
    db.commit()
    db.refresh(album)
    return album


def test_candidates_ranking(client, seeded, db, family_headers):
    """candidates がスコア降順・rank付き・SAS付きで返る。"""
    call = _make_call(db, seeded)
    _seed_candidates(db, call, n=6)
    res = client.get(f"/calls/{call.id}/candidates", headers=family_headers)
    assert res.status_code == 200
    body = res.json()
    assert len(body["candidates"]) == 6
    # score 降順・rank 昇順
    scores = [c["score"] for c in body["candidates"]]
    assert scores == sorted(scores, reverse=True)
    assert [c["rank"] for c in body["candidates"]] == [1, 2, 3, 4, 5, 6]
    assert body["candidates"][0]["sas_url"]
    assert body["auto_confirm_at"] is not None


def test_candidates_404_when_no_album(client, seeded, db, family_headers):
    """album 未作成なら candidates は 404。"""
    call = _make_call(db, seeded)
    res = client.get(f"/calls/{call.id}/candidates", headers=family_headers)
    assert res.status_code == 404


def test_selection_happy(client, seeded, db, family_headers, fake_queue):
    """5枚選択で generating へ遷移し render を投函する。"""
    call = _make_call(db, seeded)
    _seed_candidates(db, call, n=6)
    cand = client.get(f"/calls/{call.id}/candidates", headers=family_headers).json()
    top5 = [c["id"] for c in cand["candidates"][:5]]

    res = client.post(
        f"/calls/{call.id}/selection",
        headers=family_headers,
        json={"memory_ids": top5, "title": "夏の思い出"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "generating"
    assert body["auto_confirmed"] is False
    assert body["selected_memory_ids"] == top5
    assert body["title"] == "夏の思い出"

    # render 投函
    assert any(m["job_type"] == "render" for m in fake_queue.messages)

    # memories: 選ばれた5=selected、残り=candidate
    db.expire_all()
    selected = [
        m for m in db.query(Memory).filter(Memory.call_id == call.id).all()
        if m.status == "selected"
    ]
    assert len(selected) == 5


def test_selection_requires_exactly_five(client, seeded, db, family_headers):
    """4枚は 422（スキーマ検証）。"""
    call = _make_call(db, seeded)
    album = _seed_candidates(db, call, n=6)  # noqa: F841
    cand = client.get(f"/calls/{call.id}/candidates", headers=family_headers).json()
    four = [c["id"] for c in cand["candidates"][:4]]
    res = client.post(
        f"/calls/{call.id}/selection", headers=family_headers, json={"memory_ids": four}
    )
    assert res.status_code == 422


def test_selection_conflict_when_generating(client, seeded, db, family_headers):
    """generating 中の selection は 409。"""
    call = _make_call(db, seeded)
    _seed_candidates(db, call, n=6)
    cand = client.get(f"/calls/{call.id}/candidates", headers=family_headers).json()
    top5 = [c["id"] for c in cand["candidates"][:5]]
    # 1回目で generating に
    client.post(
        f"/calls/{call.id}/selection", headers=family_headers, json={"memory_ids": top5}
    )
    # 生成中の2回目は 409
    res = client.post(
        f"/calls/{call.id}/selection", headers=family_headers, json={"memory_ids": top5}
    )
    assert res.status_code == 409


def test_selection_reselect_after_ready(client, seeded, db, family_headers, fake_queue):
    """ready からの再選択は再生成（generating へ・render再投函）。"""
    call = _make_call(db, seeded)
    album = _seed_candidates(db, call, n=6)
    cand = client.get(f"/calls/{call.id}/candidates", headers=family_headers).json()
    ids = [c["id"] for c in cand["candidates"]]

    # album を ready 状態にしておく（前回生成完了を模擬）
    album.status = "ready"
    db.commit()

    res = client.post(
        f"/calls/{call.id}/selection",
        headers=family_headers,
        json={"memory_ids": ids[1:6]},  # 別の5枚
    )
    assert res.status_code == 200
    assert res.json()["status"] == "generating"
    assert any(m["job_type"] == "render" for m in fake_queue.messages)


def test_selection_rejects_foreign_memory(client, seeded, db, family_headers):
    """他通話の memory_id を含む選択は 400。"""
    call = _make_call(db, seeded)
    _seed_candidates(db, call, n=6)
    cand = client.get(f"/calls/{call.id}/candidates", headers=family_headers).json()
    ids = [c["id"] for c in cand["candidates"][:4]]
    ids.append("00000000-0000-0000-0000-000000000000")
    res = client.post(
        f"/calls/{call.id}/selection", headers=family_headers, json={"memory_ids": ids}
    )
    assert res.status_code == 400
