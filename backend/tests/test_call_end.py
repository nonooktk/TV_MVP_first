"""POST /calls/{call_id}/end（契約変更②）と着信失効（M1）のテスト。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import update

from app.db.models import Call


def _create_call(client, seeded, family_headers) -> dict:
    res = client.post(
        "/calls",
        headers=family_headers,
        json={"device_id": str(seeded["device_id"])},
    )
    assert res.status_code == 201
    return res.json()


def test_end_by_family(client, seeded, family_headers):
    """家族 Bearer で end → 200・status=ended・ended_at 記録。"""
    call = _create_call(client, seeded, family_headers)
    res = client.post(f"/calls/{call['id']}/end", headers=family_headers)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ended"
    assert body["ended_at"] is not None


def test_end_by_device(client, seeded, family_headers, device_headers):
    """デバイス X-Device-Token で end → 200・status=ended。"""
    call = _create_call(client, seeded, family_headers)
    # 応答（active）してから高齢者側が「きる」
    ans = client.post(f"/calls/{call['id']}/answer", headers=device_headers)
    assert ans.status_code == 200
    res = client.post(f"/calls/{call['id']}/end", headers=device_headers)
    assert res.status_code == 200
    assert res.json()["status"] == "ended"


def test_end_idempotent(client, seeded, family_headers, device_headers):
    """既に ended の通話への end は何もせず 200（冪等・ended_at 不変）。"""
    call = _create_call(client, seeded, family_headers)
    first = client.post(f"/calls/{call['id']}/end", headers=family_headers)
    assert first.status_code == 200
    ended_at_1 = first.json()["ended_at"]

    # 家族から再実行 → 200・ended_at 不変
    second = client.post(f"/calls/{call['id']}/end", headers=family_headers)
    assert second.status_code == 200
    assert second.json()["ended_at"] == ended_at_1

    # もう一方の認証（デバイス）から再実行しても 200・ended_at 不変
    third = client.post(f"/calls/{call['id']}/end", headers=device_headers)
    assert third.status_code == 200
    assert third.json()["ended_at"] == ended_at_1


def test_end_requires_auth(client, seeded, family_headers):
    """認証なしの end は 401。"""
    call = _create_call(client, seeded, family_headers)
    res = client.post(f"/calls/{call['id']}/end")
    assert res.status_code == 401


def test_end_unknown_call(client, seeded, family_headers):
    """存在しない通話の end は 404。"""
    res = client.post(
        "/calls/00000000-0000-0000-0000-000000000000/end", headers=family_headers
    )
    assert res.status_code == 404


def test_end_does_not_break_media_register_transition(
    client, seeded, family_headers
):
    """media/register の既存 ended 遷移が end API と共存する（end 済みでも 201）。"""
    call = _create_call(client, seeded, family_headers)
    client.post(f"/calls/{call['id']}/end", headers=family_headers)
    res = client.post(
        "/media/register",
        headers=family_headers,
        json={
            "call_id": call["id"],
            "items": [
                {
                    "type": "photo",
                    "storage_key": f"families/x/calls/{call['id']}/candidates/a.jpg",
                    "captured_at": "2026-07-04T00:00:00Z",
                }
            ],
        },
    )
    assert res.status_code == 201


def test_incoming_expires_after_ttl(client, seeded, family_headers, device_headers, db):
    """作成から120秒を超えた calling は着信として返さない（失効）。"""
    call = _create_call(client, seeded, family_headers)

    # 失効前は着信として見える
    inc = client.get("/calls/incoming", headers=device_headers)
    assert inc.json()["incoming"] is True

    # created_at を 121 秒前へ戻す（DB直接更新で経過時間を模擬）
    db.execute(
        update(Call)
        .where(Call.id == call["id"])
        .values(created_at=datetime.now(timezone.utc) - timedelta(seconds=121))
    )
    db.commit()

    inc2 = client.get("/calls/incoming", headers=device_headers)
    assert inc2.json()["incoming"] is False

    # 失効した calling でも answer 自体は可能（着信一覧から消えるだけの仕様）
    # → ここでは仕様確認として着信解消のみを検収対象とする。
