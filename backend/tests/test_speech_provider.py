"""Speech プロバイダの自動切替（STT・削減ラダー②解除）と Real 実装のユニットテスト。

実際の Speech キーは使わない（ダミー値のみ）。Real のトークン取得は httpx の
issueToken 呼び出しをモックし、応答（生 JWT 文字列）からの SpeechToken 形成を検証する。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.api.deps import get_speech_provider
from app.core.config import Settings
from app.services.speech import (
    SPEECH_TOKEN_TTL_SECONDS,
    FakeSpeechTokenProvider,
    RealSpeechTokenProvider,
)

# ダミー設定（.env を読まないよう _env_file=None を指定する）
_BASE_KWARGS = dict(
    _env_file=None,
    DATABASE_URL="postgresql://x:x@localhost:5433/x",
    AZURE_STORAGE_CONNECTION_STRING="UseDevelopmentStorage=true",
    DEV_FAMILY_TOKEN="dev-fixed-token",
)

_DUMMY_KEY = "dummy-speech-key-not-a-real-secret"
_DUMMY_REGION = "japaneast"
# issueToken が返す JWT を模した文字列（3セグメント）。中身は検証しない。
_FAKE_JWT = "eyJhbGci.eyJyZWdpb24i.c2lnbmF0dXJl"


def test_switch_to_fake_when_both_missing():
    """両方未設定 → Fake。"""
    settings = Settings(**_BASE_KWARGS)
    provider = get_speech_provider(settings=settings)
    assert isinstance(provider, FakeSpeechTokenProvider)


def test_switch_to_fake_when_region_missing():
    """KEY のみ（region なし）→ Fake（現デモ環境を壊さない）。"""
    settings = Settings(**_BASE_KWARGS, AZURE_SPEECH_KEY=_DUMMY_KEY)
    provider = get_speech_provider(settings=settings)
    assert isinstance(provider, FakeSpeechTokenProvider)


def test_switch_to_fake_when_key_missing():
    """region のみ（KEY なし）→ Fake。"""
    settings = Settings(**_BASE_KWARGS, AZURE_SPEECH_REGION=_DUMMY_REGION)
    provider = get_speech_provider(settings=settings)
    assert isinstance(provider, FakeSpeechTokenProvider)


def test_switch_to_real_when_both_present():
    """両方設定 → Real。region は公開値として参照できる。"""
    settings = Settings(
        **_BASE_KWARGS,
        AZURE_SPEECH_KEY=_DUMMY_KEY,
        AZURE_SPEECH_REGION=_DUMMY_REGION,
    )
    provider = get_speech_provider(settings=settings)
    assert isinstance(provider, RealSpeechTokenProvider)
    assert provider.region == _DUMMY_REGION


def test_fake_provider_issues_fake_prefixed_token():
    """Fake は 'fake-speech-' プレフィックスのトークンを返す。"""
    tok = FakeSpeechTokenProvider().issue()
    assert tok.token.startswith("fake-speech-")
    assert tok.region == "japaneast"


def test_real_provider_forms_token_from_issue_token(monkeypatch):
    """Real が issueToken の応答（生 JWT）から SpeechToken を形成する（HTTP はモック）。"""
    captured: dict = {}

    def fake_post(url, headers=None, timeout=None, **kwargs):
        captured["url"] = url
        captured["headers"] = headers or {}
        req = httpx.Request("POST", url)
        return httpx.Response(200, text=_FAKE_JWT, request=req)

    monkeypatch.setattr(httpx, "post", fake_post)

    provider = RealSpeechTokenProvider(_DUMMY_KEY, _DUMMY_REGION)
    before = datetime.now(timezone.utc)
    tok = provider.issue()

    # 応答の JWT がそのままトークンになる（Fake 形式ではない）。
    assert tok.token == _FAKE_JWT
    assert not tok.token.startswith("fake-")
    assert tok.region == _DUMMY_REGION
    # エンドポイントは STS の issueToken。
    assert captured["url"] == (
        f"https://{_DUMMY_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken"
    )
    # 秘密キーは Ocp-Apim-Subscription-Key ヘッダで渡す。
    assert captured["headers"]["Ocp-Apim-Subscription-Key"] == _DUMMY_KEY
    # 有効期限 ≈ SPEECH_TOKEN_TTL_SECONDS（約10分）。
    delta = tok.expires_at - before
    assert timedelta(seconds=SPEECH_TOKEN_TTL_SECONDS - 5) <= delta <= timedelta(
        seconds=SPEECH_TOKEN_TTL_SECONDS + 5
    )


def test_real_provider_raises_on_empty_token(monkeypatch):
    """issueToken が空文字を返したら RuntimeError（無害に Fake へは落とさない）。"""
    monkeypatch.setattr(
        httpx,
        "post",
        lambda url, **k: httpx.Response(
            200, text="   ", request=httpx.Request("POST", url)
        ),
    )
    provider = RealSpeechTokenProvider(_DUMMY_KEY, _DUMMY_REGION)
    with pytest.raises(RuntimeError):
        provider.issue()


def test_real_provider_does_not_expose_key():
    """repr にキーが含まれない（秘密値の漏出防止）。"""
    provider = RealSpeechTokenProvider(_DUMMY_KEY, _DUMMY_REGION)
    assert _DUMMY_KEY not in repr(provider)
