"""Agora トークン発行のインターフェースと実装（Fake / Real）。

M1（Agora 実接続）で RealAgoraTokenProvider を追加した。
- AGORA_APP_ID / AGORA_APP_CERTIFICATE の両方が設定されていれば Real、
  どちらか欠けていれば Fake を使う（切替は app/api/deps.py の DI で行う）。
- App Certificate は秘密値。トークン文字列の生成のみに使い、
  ログ・例外メッセージ・repr のいずれにも出力しない。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol
from uuid import uuid4

# --- 定数 -----------------------------------------------------------------

# トークン有効期限（秒）。MVP 初期値（1時間）。運用に合わせて見直す場合はここを変更する。
TOKEN_TTL_SECONDS = 3600

# uid の固定ルール（1対1・channel 名は通話ごとにローテーションするため衝突しない）。
# M2（検知コア②）で「uid=2 の高齢者ストリームに検知を接続する」ための布石として固定する。
UID_FAMILY = 1  # 家族側（発信者・/tokens/call で発行）
UID_ELDER = 2   # 高齢者側（待受デバイス・/calls/{id}/answer で発行）

# Agora RTC の role 値（agora-token-builder の Role_Publisher に対応）。
# 家族・高齢者とも映像/音声を publish するため両側 publisher。
_ROLE_PUBLISHER = 1

# Fake プロバイダが返すダミーの App ID（公開値の形だけ模す。実プロジェクトとは無関係）。
FAKE_APP_ID = "fake-agora-app-id"


@dataclass
class AgoraToken:
    """Agora チャンネル入室用トークン。"""

    token: str
    channel_name: str
    uid: int
    expires_at: datetime


class AgoraTokenProvider(Protocol):
    """Agora トークン発行のインターフェース。

    app_id は公開値（フロントの SDK join に必要）で、トークン応答にも含める。
    """

    app_id: str

    def issue(
        self, channel_name: str, uid: int, ttl_seconds: int = TOKEN_TTL_SECONDS
    ) -> AgoraToken:
        """指定チャンネル・uid の入室トークンを発行する。"""
        ...


class FakeAgoraTokenProvider:
    """Fake 実装。"fake-" プレフィックスのトークンと expires_at を返す。

    Agora アカウント未設定（AGORA_APP_ID / AGORA_APP_CERTIFICATE が空）の
    デモ環境で使う。実チャンネルへの入室はできない。
    """

    app_id = FAKE_APP_ID

    def issue(
        self, channel_name: str, uid: int, ttl_seconds: int = TOKEN_TTL_SECONDS
    ) -> AgoraToken:
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
        return AgoraToken(
            token=f"fake-agora-{uuid4().hex}",
            channel_name=channel_name,
            uid=uid,
            expires_at=expires_at,
        )


class RealAgoraTokenProvider:
    """agora-token-builder による本実装（M1）。

    RtcTokenBuilder.buildTokenWithUid で role=publisher のトークンを生成する。
    App Certificate は本クラス内に閉じ込め、外部へ出力しない。
    """

    def __init__(self, app_id: str, app_certificate: str) -> None:
        if not app_id or not app_certificate:
            raise ValueError("AGORA_APP_ID / AGORA_APP_CERTIFICATE の両方が必要です")
        self.app_id = app_id
        # 秘密値。ログ・repr へ出さないこと。
        self._app_certificate = app_certificate

    def __repr__(self) -> str:  # 秘密値の漏出防止
        return f"RealAgoraTokenProvider(app_id={self.app_id!r})"

    def issue(
        self, channel_name: str, uid: int, ttl_seconds: int = TOKEN_TTL_SECONDS
    ) -> AgoraToken:
        # 遅延 import: Fake 運用（証明書なし）の環境ではパッケージ未導入でも動くようにする。
        from agora_token_builder import RtcTokenBuilder

        now = datetime.now(timezone.utc)
        privilege_expired_ts = int(time.time()) + ttl_seconds
        token = RtcTokenBuilder.buildTokenWithUid(
            self.app_id,
            self._app_certificate,
            channel_name,
            uid,
            _ROLE_PUBLISHER,
            privilege_expired_ts,
        )
        return AgoraToken(
            token=token,
            channel_name=channel_name,
            uid=uid,
            expires_at=now + timedelta(seconds=ttl_seconds),
        )
