"""Agora プロバイダの自動切替（M1）と Real 実装のユニットテスト。

実際の App Certificate は使わない（ダミー値のみ）。トークン生成は
agora-token-builder の HMAC 計算だけで完結するため、ダミー値でも形式検証ができる。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.api.deps import get_agora_provider
from app.core.config import Settings
from app.services.agora import (
    TOKEN_TTL_SECONDS,
    UID_ELDER,
    UID_FAMILY,
    FakeAgoraTokenProvider,
    RealAgoraTokenProvider,
)

# ダミー設定（.env を読まないよう _env_file=None を指定する）
_BASE_KWARGS = dict(
    _env_file=None,
    DATABASE_URL="postgresql://x:x@localhost:5433/x",
    AZURE_STORAGE_CONNECTION_STRING="UseDevelopmentStorage=true",
    DEV_FAMILY_TOKEN="dev-fixed-token",
)

# Agora App ID は 32桁hex 形式の公開値。テストではダミーを使う。
_DUMMY_APP_ID = "0123456789abcdef0123456789abcdef"
_DUMMY_CERT = "dummy-certificate-not-a-real-secret"


def test_switch_to_fake_when_both_missing():
    """両方未設定 → Fake。"""
    settings = Settings(**_BASE_KWARGS)
    provider = get_agora_provider(settings=settings)
    assert isinstance(provider, FakeAgoraTokenProvider)


def test_switch_to_fake_when_certificate_missing():
    """APP_ID のみ（証明書なし）→ Fake（現デモ環境を壊さない）。"""
    settings = Settings(**_BASE_KWARGS, AGORA_APP_ID=_DUMMY_APP_ID)
    provider = get_agora_provider(settings=settings)
    assert isinstance(provider, FakeAgoraTokenProvider)


def test_switch_to_fake_when_app_id_missing():
    """証明書のみ（APP_ID なし）→ Fake。"""
    settings = Settings(**_BASE_KWARGS, AGORA_APP_CERTIFICATE=_DUMMY_CERT)
    provider = get_agora_provider(settings=settings)
    assert isinstance(provider, FakeAgoraTokenProvider)


def test_switch_to_real_when_both_present():
    """両方設定 → Real。app_id は公開値として参照できる。"""
    settings = Settings(
        **_BASE_KWARGS,
        AGORA_APP_ID=_DUMMY_APP_ID,
        AGORA_APP_CERTIFICATE=_DUMMY_CERT,
    )
    provider = get_agora_provider(settings=settings)
    assert isinstance(provider, RealAgoraTokenProvider)
    assert provider.app_id == _DUMMY_APP_ID


def test_real_provider_issues_agora_format_token():
    """Real がダミー証明書で Agora 形式（'006'+app_id 先頭）のトークンを生成する。"""
    provider = RealAgoraTokenProvider(_DUMMY_APP_ID, _DUMMY_CERT)
    before = datetime.now(timezone.utc)
    tok = provider.issue("ch-test", uid=UID_FAMILY)
    # agora-token-builder v1 は "006" + appId で始まるトークンを返す
    assert tok.token.startswith("006" + _DUMMY_APP_ID)
    assert tok.channel_name == "ch-test"
    assert tok.uid == UID_FAMILY
    # 有効期限 ≈ TOKEN_TTL_SECONDS（3600秒・MVP初期値）
    delta = tok.expires_at - before
    assert timedelta(seconds=TOKEN_TTL_SECONDS - 5) <= delta <= timedelta(
        seconds=TOKEN_TTL_SECONDS + 5
    )


def test_real_provider_does_not_expose_certificate():
    """repr に証明書が含まれない（秘密値の漏出防止）。"""
    provider = RealAgoraTokenProvider(_DUMMY_APP_ID, _DUMMY_CERT)
    assert _DUMMY_CERT not in repr(provider)


def test_uid_constants():
    """uid ルール: 家族=1・高齢者=2（M2 の検知接続の前提）。"""
    assert UID_FAMILY == 1
    assert UID_ELDER == 2
