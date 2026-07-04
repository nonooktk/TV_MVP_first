"""認証2系統（家族 Bearer・デバイス X-Device-Token）の成否テスト。"""

from __future__ import annotations


def test_family_auth_ok(client, seeded, family_headers):
    """正しい Bearer トークンで albums 一覧が取得できる。"""
    res = client.get("/albums", headers=family_headers)
    assert res.status_code == 200
    assert res.json()["items"] == []


def test_family_auth_missing(client, seeded):
    """Bearer なしは 401。"""
    res = client.get("/albums")
    assert res.status_code == 401


def test_family_auth_wrong_token(client, seeded):
    """不正な Bearer は 401。"""
    res = client.get("/albums", headers={"Authorization": "Bearer wrong"})
    assert res.status_code == 401


def test_device_auth_ok(client, seeded, device_headers):
    """正しい X-Device-Token で incoming が取得できる。"""
    res = client.get("/calls/incoming", headers=device_headers)
    assert res.status_code == 200
    assert res.json()["incoming"] is False


def test_device_auth_missing(client, seeded):
    """X-Device-Token なしは 401。"""
    res = client.get("/calls/incoming")
    assert res.status_code == 401


def test_device_auth_wrong_token(client, seeded):
    """不正な X-Device-Token は 401。"""
    res = client.get("/calls/incoming", headers={"X-Device-Token": "nope"})
    assert res.status_code == 401
