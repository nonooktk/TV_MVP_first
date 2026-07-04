"""Azure Speech トークン発行のインターフェースと Fake 実装。

MVP 期間中は Azure アカウントが無いため FakeSpeechTokenProvider を使う。
本番導入時（A1）に Azure Speech の短命トークン発行へ差し替える（DIで切り替え）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol
from uuid import uuid4


@dataclass
class SpeechToken:
    """Azure Speech STT 用の短命トークン。"""

    token: str
    region: str
    expires_at: datetime


class SpeechTokenProvider(Protocol):
    """Speech トークン発行のインターフェース。"""

    def issue(self, ttl_seconds: int = 600) -> SpeechToken:
        """STT 用の短命トークンを発行する。"""
        ...


class FakeSpeechTokenProvider:
    """Fake 実装。"fake-" プレフィックスのトークンと expires_at を返す。"""

    # 東日本で統一（確定済み設計判断）。
    region = "japaneast"

    def issue(self, ttl_seconds: int = 600) -> SpeechToken:
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
        return SpeechToken(
            token=f"fake-speech-{uuid4().hex}",
            region=self.region,
            expires_at=expires_at,
        )
