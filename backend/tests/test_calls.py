"""calls 作成 → incoming → answer の流れテスト。"""

from __future__ import annotations


def test_call_lifecycle(client, seeded, family_headers, device_headers):
    """発信 → 着信検知 → 応答（active化・トークン発行）の一連。"""
    # 発信
    res = client.post(
        "/calls",
        headers=family_headers,
        json={"device_id": str(seeded["device_id"])},
    )
    assert res.status_code == 201
    call = res.json()
    assert call["status"] == "calling"
    assert call["channel_name"].startswith("ch-")
    call_id = call["id"]

    # 高齢者側の着信検知
    inc = client.get("/calls/incoming", headers=device_headers)
    assert inc.status_code == 200
    inc_body = inc.json()
    assert inc_body["incoming"] is True
    assert inc_body["call_id"] == call_id
    assert inc_body["family_name"] == "テスト家族"

    # 応答（でる）
    ans = client.post(f"/calls/{call_id}/answer", headers=device_headers)
    assert ans.status_code == 200
    ans_body = ans.json()
    assert ans_body["token"].startswith("fake-")
    assert ans_body["channel_name"] == call["channel_name"]
    # uid ルール（M1）: 高齢者=2。app_id（公開値）も応答に含まれる（契約変更①）。
    assert ans_body["uid"] == 2
    assert ans_body["app_id"]

    # 応答済みなので着信は消える
    inc2 = client.get("/calls/incoming", headers=device_headers)
    assert inc2.json()["incoming"] is False

    # 二重応答は 409
    ans2 = client.post(f"/calls/{call_id}/answer", headers=device_headers)
    assert ans2.status_code == 409


def test_create_call_unknown_device(client, seeded, family_headers):
    """存在しないデバイスIDは 404。"""
    res = client.post(
        "/calls",
        headers=family_headers,
        json={"device_id": "00000000-0000-0000-0000-000000000000"},
    )
    assert res.status_code == 404


# --- device_id 自動解決（v0.4.0・既知課題#5 対応）------------------------------


def test_create_call_without_device_id(client, seeded, family_headers):
    """device_id 省略時は当該家族の active デバイスへ自動解決して 201。"""
    res = client.post("/calls", headers=family_headers, json={})
    assert res.status_code == 201
    body = res.json()
    assert body["status"] == "calling"
    assert body["device_id"] == str(seeded["device_id"])


def test_create_call_without_device_id_no_active(client, seeded, family_headers, db):
    """active なデバイスが1台も無ければ 404 code="no_active_device"。"""
    from app.db.models import Device

    device = db.get(Device, seeded["device_id"])
    device.status = "revoked"
    db.commit()

    res = client.post("/calls", headers=family_headers, json={})
    assert res.status_code == 404
    detail = res.json()["detail"]
    assert detail["code"] == "no_active_device"
    assert "相手の設定" in detail["message"]


def test_create_call_without_device_id_multiple_active(
    client, seeded, family_headers, db
):
    """active が複数件あれば最新 registered_at のデバイスを採用する。"""
    from datetime import datetime, timedelta, timezone

    from app.core.security import sha256_hex
    from app.db.models import Device

    # seeded のデバイスより新しい registered_at で2台目を登録する。
    newer = Device(
        family_id=seeded["family_id"],
        fixed_contact_user_id=seeded["owner_id"],
        status="active",
        device_token_hash=sha256_hex("second-device-token"),
        registered_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )
    db.add(newer)
    db.commit()
    db.refresh(newer)

    res = client.post("/calls", headers=family_headers, json={})
    assert res.status_code == 201
    assert res.json()["device_id"] == str(newer.id)


def test_create_call_with_explicit_device_id_keeps_behavior(
    client, seeded, family_headers, db
):
    """明示指定時は従来挙動（指定デバイスを採用。より新しい別デバイスがあっても）。"""
    from datetime import datetime, timedelta, timezone

    from app.core.security import sha256_hex
    from app.db.models import Device

    newer = Device(
        family_id=seeded["family_id"],
        fixed_contact_user_id=seeded["owner_id"],
        status="active",
        device_token_hash=sha256_hex("third-device-token"),
        registered_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )
    db.add(newer)
    db.commit()

    res = client.post(
        "/calls",
        headers=family_headers,
        json={"device_id": str(seeded["device_id"])},
    )
    assert res.status_code == 201
    assert res.json()["device_id"] == str(seeded["device_id"])


def test_call_token(client, seeded, family_headers):
    """/tokens/call が Fake トークンを返す。"""
    call = client.post(
        "/calls",
        headers=family_headers,
        json={"device_id": str(seeded["device_id"])},
    ).json()
    res = client.post(
        "/tokens/call", headers=family_headers, json={"call_id": call["id"]}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["token"].startswith("fake-")
    # uid ルール（M1）: 家族=1。app_id（公開値）も応答に含まれる（契約変更①）。
    assert body["uid"] == 1
    assert body["app_id"]


def test_speech_token(client, seeded, family_headers):
    """/tokens/speech が Fake トークンと region を返す。"""
    res = client.post("/tokens/speech", headers=family_headers)
    assert res.status_code == 200
    body = res.json()
    assert body["token"].startswith("fake-")
    assert body["region"] == "japaneast"
