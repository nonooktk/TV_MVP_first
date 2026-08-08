"""ENV=production で Swagger/ReDoc/openapi.json が非公開になることのテスト。

指摘: 本番でも /docs・/redoc・/openapi.json が 200 で公開されたままだった。
main.py で ENV!=production のときのみ docs_url 等を有効化するよう修正した。
"""

from __future__ import annotations

import importlib

from fastapi.testclient import TestClient


def test_docs_disabled_when_env_production(monkeypatch):
    """ENV=production で app を再構築すると /docs・/redoc・/openapi.json が 404 になる。"""
    from app.core.config import get_settings

    monkeypatch.setenv("ENV", "production")
    get_settings.cache_clear()

    import app.main as main_module

    importlib.reload(main_module)
    try:
        with TestClient(main_module.app) as c:
            assert c.get("/docs").status_code == 404
            assert c.get("/redoc").status_code == 404
            assert c.get("/openapi.json").status_code == 404
            assert c.get("/healthz").status_code == 200
    finally:
        monkeypatch.delenv("ENV", raising=False)
        get_settings.cache_clear()
        importlib.reload(main_module)


def test_docs_enabled_by_default(client: TestClient):
    """既定（development）では従来どおり /docs・/openapi.json が閲覧できる。"""
    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").status_code == 200
