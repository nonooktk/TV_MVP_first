"""FastAPI の共通依存（認証2系統・サービスDI）。

- 家族認証（`require_family`）: Authorization: Bearer を次の多段構えで解決する。
  1. トークンが settings.DEV_FAMILY_TOKEN と一致 → シード済み owner へ解決（開発用の裏口）。
  2. 不一致 → JWT の iss を「未検証デコード」で覗き、発行者に応じて検証器へ振り分ける:
     - Google（iss=accounts.google.com 系）→ settings.GOOGLE_CLIENT_ID が非空なら
       app.core.google で ID トークンを検証（主体キー=`google:{sub}`）。
     - それ以外（Entra 想定）→ settings.ENTRA_CLIENT_ID が非空なら app.core.entra で
       v2.0 アクセストークンを検証（主体キー=`entra:{oid|sub}`）。
     該当プロバイダが未設定（クライアントID 空）なら 401。
  検証成功なら auth_id（プレフィックス付き）で users を解決し、無ければ家族＋owner を
  自動プロビジョニングする（Google/Entra 共用）。
  両プロバイダとも未設定なら、dev トークン以外の Bearer はすべて 401。
- デバイス認証（`require_device`）: X-Device-Token を sha256 して devices.device_token_hash と
  照合する（status=active のみ通す）。こちらは本実装。

**auth_id のプレフィックス方式**: 家族ユーザーの users.auth_id はプロバイダ接頭辞を付ける
（Google=`google:{sub}`・Entra=`entra:{oid}`）。プロバイダをまたいだ主体キーの衝突を防ぎ、
どのプロバイダ由来かを構造で判別できるようにする。実ユーザー未登場のため既存データの移行は不要。

Blob/Queue/Agora/Speech の各サービスは、テスト時に差し替えられるよう依存として供給する。
"""

from __future__ import annotations

import logging

import jwt
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.entra import EntraTokenError, verify_entra_token
from app.core.google import GoogleTokenError, verify_google_token
from app.core.security import sha256_hex
from app.db.models import Device, Family, User
from app.db.session import get_db
from app.services.agora import (
    AgoraTokenProvider,
    FakeAgoraTokenProvider,
    RealAgoraTokenProvider,
)
from app.services.blob import BlobService
from app.services.queue import QueueService
from app.services.speech import (
    FakeSpeechTokenProvider,
    RealSpeechTokenProvider,
    SpeechTokenProvider,
)

logger = logging.getLogger(__name__)


# --- 認証 ---------------------------------------------------------------------


def _resolve_dev_family_owner(db: Session) -> User:
    """開発用固定トークンの解決先（シード済み owner）を返す。

    従来のスタブ挙動。owner が未シードなら 401。
    """
    user = db.scalars(
        select(User).where(User.role == "owner").order_by(User.created_at)
    ).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "unauthorized",
                "message": "owner ユーザーが未シードです（seed.py を実行してください）",
            },
        )
    return user


def _provision_or_get_by_auth_id(
    db: Session, auth_id: str, name: str | None
) -> User:
    """主体（auth_id＝プレフィックス付き）に対応する家族側ユーザーを返す（Google/Entra 共用）。

    - auth_id で users を検索して見つかればそのユーザーを返す（既存家族に解決）。
    - 見つからなければ、その auth_id 用の家族（families）＋ owner ユーザー（users）を
      新規作成して返す（初回ログイン時の自動プロビジョニング）。以後はその family に解決され、
      既存の家族スコープ機構にそのまま乗る。

    auth_id は呼び出し側でプロバイダ接頭辞を付けた値（`google:{sub}` / `entra:{oid}`）を渡す。
    家族名は「{表示名 または 'わたし'}の家族」。表示名（name）は users に保存する列が
    無いため（スコープ外）、家族名の生成にのみ使う。
    """
    user = db.scalars(select(User).where(User.auth_id == auth_id)).first()
    if user is not None:
        return user

    display = name if name else "わたし"
    family = Family(name=f"{display}の家族")
    db.add(family)
    db.flush()
    user = User(family_id=family.id, role="owner", auth_id=auth_id)
    db.add(user)
    db.commit()
    db.refresh(user)
    logger.info(
        "初回ログイン: 家族と owner を自動作成しました family_id=%s auth_id=%s",
        family.id,
        auth_id,
    )
    return user


def _peek_unverified_issuer(token: str) -> str | None:
    """JWT を「署名検証せず」デコードして iss（発行者）だけを覗く（振り分け専用）。

    プロバイダ（Google / Entra）を判別するためだけに使う。**ここでの iss は信用しない**
    ＝実際の検証（署名・aud・iss の厳密判定）は各プロバイダの検証器が行う。JWT として
    parse できない・iss が無い場合は None を返す（呼び出し側で 401 にする）。
    """
    try:
        payload = jwt.decode(token, options={"verify_signature": False})
    except Exception:  # noqa: BLE001  # JWT でない・壊れている
        return None
    iss = payload.get("iss")
    return iss if isinstance(iss, str) else None


# Google の iss（未検証デコードでの振り分け用。厳密判定は app.core.google が行う）。
_GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")


def require_family(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    """家族認証（多段構え: 開発用固定トークン ＋ Google / Entra マルチプロバイダ）。

    1. Bearer が settings.DEV_FAMILY_TOKEN と一致 → シード済み owner を返す（開発用の裏口）。
    2. 不一致 → JWT の iss を未検証デコードで覗いて発行者を判別し、対応する検証器へ振り分ける:
       - Google（iss=accounts.google.com 系）: GOOGLE_CLIENT_ID 非空なら ID トークンを検証し、
         auth_id=`google:{sub}` で users を解決（無ければ家族＋owner を自動作成）。
       - それ以外（Entra 想定）: ENTRA_CLIENT_ID 非空なら v2.0 アクセストークンを検証し、
         auth_id=`entra:{oid}` で解決（同上）。
       該当プロバイダが未設定（クライアントID 空）なら 401。
    どのプロバイダも設定されていなければ、dev トークン以外の Bearer はすべて 401。
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "Bearer トークンが必要です"},
        )
    token = authorization.split(" ", 1)[1].strip()

    # 1) 開発用固定トークン（各プロバイダ有効時も併存する裏口）。
    #    F-3（SECURITY_REPORT_2026-07-19）対応: DEV_FAMILY_TOKEN が**非空のときだけ**照合する。
    #    本番では env から DEV_FAMILY_TOKEN を除去する運用のため、空のときに `token == ""`
    #    （＝空文字 Bearer など）が裏口とマッチする穴を塞ぐ。空なら dev トークン経路は無効化され、
    #    Google/Entra のみで認証する。
    if settings.DEV_FAMILY_TOKEN and token == settings.DEV_FAMILY_TOKEN:
        return _resolve_dev_family_owner(db)

    # 2) iss（未検証）を見てプロバイダへ振り分ける。iss の厳密判定は各検証器が行う。
    issuer = _peek_unverified_issuer(token)

    # 2a) Google ID トークン（GOOGLE_CLIENT_ID 設定時のみ）。
    if issuer in _GOOGLE_ISSUERS:
        if not settings.GOOGLE_CLIENT_ID:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": "unauthorized", "message": "トークンが無効です"},
            )
        try:
            gclaims = verify_google_token(token, settings.GOOGLE_CLIENT_ID)
        except GoogleTokenError as e:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": "unauthorized", "message": "トークンが無効です"},
            ) from e
        return _provision_or_get_by_auth_id(
            db, f"google:{gclaims.sub}", gclaims.name
        )

    # 2b) Entra ID トークン（ENTRA_CLIENT_ID 設定時のみ。Google 以外の iss を Entra 扱い）。
    if settings.ENTRA_CLIENT_ID:
        try:
            eclaims = verify_entra_token(token, settings.ENTRA_CLIENT_ID)
        except EntraTokenError as e:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": "unauthorized", "message": "トークンが無効です"},
            ) from e
        return _provision_or_get_by_auth_id(
            db, f"entra:{eclaims.auth_id}", eclaims.name
        )

    # どのプロバイダも未設定で dev トークンでもない → 401。
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": "unauthorized", "message": "トークンが無効です"},
    )


def require_device(
    x_device_token: str | None = Header(default=None, alias="X-Device-Token"),
    db: Session = Depends(get_db),
) -> Device:
    """デバイス認証（本実装）。X-Device-Token を sha256 照合する。

    status=active のデバイスのみ通す。pending / revoked や不一致は 401。
    """
    if not x_device_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "X-Device-Token が必要です"},
        )
    token_hash = sha256_hex(x_device_token)
    device = db.scalars(
        select(Device).where(
            Device.device_token_hash == token_hash,
            Device.status == "active",
        )
    ).first()
    if device is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "デバイストークンが無効です"},
        )
    return device


def require_family_or_device(
    authorization: str | None = Header(default=None),
    x_device_token: str | None = Header(default=None, alias="X-Device-Token"),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> tuple[User | None, Device | None]:
    """家族 Bearer・デバイス X-Device-Token の**どちらでも**通す認証。

    POST /calls/{call_id}/end のように両側から呼べる操作で使う。
    Bearer が提示されていれば家族として、無ければ X-Device-Token をデバイスとして
    検証する。戻り値は (user, None) か (None, device)。どちらも無ければ 401。
    """
    if authorization:
        user = require_family(authorization=authorization, db=db, settings=settings)
        return user, None
    if x_device_token:
        device = require_device(x_device_token=x_device_token, db=db)
        return None, device
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={
            "code": "unauthorized",
            "message": "Bearer または X-Device-Token が必要です",
        },
    )


# --- サービスDI（テスト時に app.dependency_overrides で差し替える）-------------


def get_blob_service(
    settings: Settings = Depends(get_settings),
) -> BlobService:
    """Blob サービス（SAS発行・アップロード）を供給する。"""
    return BlobService(
        connection_string=settings.AZURE_STORAGE_CONNECTION_STRING,
        container=settings.MEDIA_CONTAINER,
    )


def get_queue_service(
    settings: Settings = Depends(get_settings),
) -> QueueService:
    """Queue サービス（パイプライン投函）を供給する。"""
    return QueueService(
        connection_string=settings.AZURE_STORAGE_CONNECTION_STRING,
        queue_name=settings.QUEUE_NAME,
    )


def get_agora_provider(
    settings: Settings = Depends(get_settings),
) -> AgoraTokenProvider:
    """Agora トークンプロバイダを供給する（M1: 設定に応じて自動切替）。

    AGORA_APP_ID と AGORA_APP_CERTIFICATE の両方が非空なら Real、
    どちらか欠けていれば Fake を返す（証明書未設定のデモ環境を壊さない）。
    """
    if settings.AGORA_APP_ID and settings.AGORA_APP_CERTIFICATE:
        return RealAgoraTokenProvider(
            app_id=settings.AGORA_APP_ID,
            app_certificate=settings.AGORA_APP_CERTIFICATE,
        )
    return FakeAgoraTokenProvider()


def get_speech_provider(
    settings: Settings = Depends(get_settings),
) -> SpeechTokenProvider:
    """Speech トークンプロバイダを供給する（STT: 設定に応じて自動切替）。

    AZURE_SPEECH_KEY と AZURE_SPEECH_REGION の両方が非空なら Real（STS 短命トークン）、
    どちらか欠けていれば Fake を返す（Speech 未設定のデモ環境を壊さない。Agora と同じ）。
    """
    if settings.AZURE_SPEECH_KEY and settings.AZURE_SPEECH_REGION:
        return RealSpeechTokenProvider(
            key=settings.AZURE_SPEECH_KEY,
            region=settings.AZURE_SPEECH_REGION,
        )
    return FakeSpeechTokenProvider()
