"""Azure Speech トークン発行のインターフェースと実装（Fake / Real）。

STT（削減ラダー②）解除で RealSpeechTokenProvider を追加した。
- AZURE_SPEECH_KEY / AZURE_SPEECH_REGION の両方が非空なら Real、
  どちらか欠けていれば Fake を使う（切替は app/api/deps.py の DI で行う。Agora と同じパターン）。
- Speech キーは秘密値。issueToken への POST にのみ使い、
  ログ・例外メッセージ・repr のいずれにも出力しない。
- Real は STS の issueToken（`https://{region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`）で
  約10分の短命トークン（JWT）を取得する。フロントはこの短命トークンで SDK 接続する。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol
from uuid import uuid4

# STS の短命トークンの推定寿命（秒）。Azure の issueToken は約10分。
# expires_at は「発行時刻＋この値」で近似する（フロントの更新間隔=約9分の根拠）。
SPEECH_TOKEN_TTL_SECONDS = 600


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

    def issue(self, ttl_seconds: int = SPEECH_TOKEN_TTL_SECONDS) -> SpeechToken:
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
        return SpeechToken(
            token=f"fake-speech-{uuid4().hex}",
            region=self.region,
            expires_at=expires_at,
        )


class RealSpeechTokenProvider:
    """Azure Speech の STS issueToken による本実装（STT・削減ラダー②解除）。

    `https://{region}.api.cognitive.microsoft.com/sts/v1.0/issueToken` へ
    `Ocp-Apim-Subscription-Key` を付けて POST し、約10分の短命トークン（JWT）を取得する。
    Speech キーは本クラス内に閉じ込め、外部（ログ・repr・例外）へは出さない。
    """

    # issueToken はボディ不要（Content-Length: 0）。応答は生の JWT 文字列。
    _ISSUE_TOKEN_PATH = "/sts/v1.0/issueToken"
    _TIMEOUT_SECONDS = 10.0

    def __init__(self, key: str, region: str) -> None:
        if not key or not region:
            raise ValueError("AZURE_SPEECH_KEY / AZURE_SPEECH_REGION の両方が必要です")
        # 秘密値。ログ・repr へ出さないこと。
        self._key = key
        self.region = region

    def __repr__(self) -> str:  # 秘密値の漏出防止
        return f"RealSpeechTokenProvider(region={self.region!r})"

    def _endpoint(self) -> str:
        return f"https://{self.region}.api.cognitive.microsoft.com{self._ISSUE_TOKEN_PATH}"

    def issue(self, ttl_seconds: int = SPEECH_TOKEN_TTL_SECONDS) -> SpeechToken:
        # 遅延 import: Fake 運用（キーなし）の環境では未導入でも動くようにする。
        import httpx

        # 発行「前」の時刻を基準に expires_at を近似する（過大評価を避ける）。
        issued_at = datetime.now(timezone.utc)
        resp = httpx.post(
            self._endpoint(),
            headers={
                "Ocp-Apim-Subscription-Key": self._key,
                "Content-Length": "0",
            },
            timeout=self._TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        token = resp.text.strip()
        if not token:
            raise RuntimeError("Speech issueToken が空のトークンを返しました")
        return SpeechToken(
            token=token,
            region=self.region,
            expires_at=issued_at + timedelta(seconds=ttl_seconds),
        )
