"""F-7: API レスポンスに X-Content-Type-Options: nosniff が付くことのテスト。

DAST(baseline) が /healthz・/openapi.json の nosniff 欠落を検出（F-7）したため、
main.py のミドルウェアで全レスポンスへ横断的に付与している。
"""

from __future__ import annotations

import pytest


@pytest.mark.parametrize("path", ["/healthz", "/openapi.json"])
def test_nosniff_header_present(client, path):
    """公開エンドポイント（/healthz・/openapi.json）に nosniff が付く。"""
    res = client.get(path)
    assert res.status_code == 200
    assert res.headers.get("X-Content-Type-Options") == "nosniff"


def test_nosniff_header_on_authed_endpoint(client, seeded, family_headers):
    """認証エンドポイントのレスポンスにも nosniff が付く（横断的に付与）。"""
    res = client.get("/albums", headers=family_headers)
    assert res.status_code == 200
    assert res.headers.get("X-Content-Type-Options") == "nosniff"
