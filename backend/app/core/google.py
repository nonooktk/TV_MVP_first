"""Google アカウント認証（Google ID トークン）の JWT 検証。

家族側ログインのマルチプロバイダ化の一環（Entra ID と対称）。フロント（Google Identity
Services＝GIS）が取得した ID トークン（JWS・RS256）を Authorization: Bearer で受け取り、
Google の公開鍵（JWKS）で署名検証する。

entra.py と対称の二段構え:
- `GOOGLE_CLIENT_ID` が空（未有効化）なら Google 検証は行わず、この経路は使わない
  （deps 側で iss を見て振り分ける際、未設定プロバイダは 401）。
- `GOOGLE_CLIENT_ID` が設定されていれば、iss が Google の Bearer を Google ID トークンとして検証する。

検証項目:
- 署名: JWKS（`https://www.googleapis.com/oauth2/v3/certs`）から kid に対応する公開鍵で RS256 検証。
- exp: 期限切れは失敗（pyjwt が自動検証）。
- aud: `GOOGLE_CLIENT_ID` に一致。
- iss: `accounts.google.com` または `https://accounts.google.com`。
主体は `sub`（Google アカウントの安定した一意 ID）。

依存: pyjwt[crypto]（entra.py と共通。署名検証に cryptography が必要）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import jwt
from jwt import PyJWKClient

logger = logging.getLogger(__name__)

# Google の公開鍵（JWKS）エンドポイント。ID トークンの署名鍵（RS256）を含む。
JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"

# 許容する iss（Google の ID トークン発行者）。両表記を許容する。
ALLOWED_ISS = ("accounts.google.com", "https://accounts.google.com")


class GoogleTokenError(Exception):
    """Google ID トークンの検証に失敗したことを表す例外。deps 側で 401 に変換する。"""


@dataclass(frozen=True)
class GoogleClaims:
    """検証済みトークンから取り出す主体情報（entra.EntraClaims と対称）。

    - sub: 主体キー（Google アカウントの一意 ID）。deps 側で `google:{sub}` に前置する。
    - name: 表示名（あれば）。家族名の生成にのみ使う（users に保存列は無い）。
    """

    sub: str
    name: str | None


# モジュール内で JWKS クライアントを1つ保持し、鍵をキャッシュする（entra.py と同じ方針）。
_jwk_client: PyJWKClient | None = None


def _get_jwk_client() -> PyJWKClient:
    """JWKS クライアント（プロセス内シングルトン）を返す。

    PyJWKClient は取得した鍵をキャッシュし、未知の kid（鍵ローテーション後など）を
    受け取った際は JWKS を取り直す。lifespan でキャッシュ有効期間を持たせる。
    """
    global _jwk_client
    if _jwk_client is None:
        _jwk_client = PyJWKClient(JWKS_URL, cache_keys=True, lifespan=3600)
    return _jwk_client


def verify_google_token(token: str, client_id: str) -> GoogleClaims:
    """Google の ID トークンを検証し、主体情報を返す。

    Raises:
        GoogleTokenError: いずれかの検証（署名・exp・aud・iss・sub 欠落）に失敗した場合。
    """
    if not client_id:
        # 呼び出し側の実装ミス（GOOGLE_CLIENT_ID 空なら本関数を呼ばない設計）。
        raise GoogleTokenError("GOOGLE_CLIENT_ID が未設定です")

    try:
        signing_key = _get_jwk_client().get_signing_key_from_jwt(token)
    except Exception as e:  # noqa: BLE001  # 鍵解決失敗（不正な形・未知 kid・取得失敗）
        raise GoogleTokenError(f"署名鍵の解決に失敗しました: {e}") from e

    try:
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=client_id,
            # iss は pyjwt の完全一致検証だと単一値しか渡せないため、下で明示的に検証する。
            options={
                "require": ["exp", "aud", "iss"],
                "verify_aud": True,
                "verify_exp": True,
                "verify_signature": True,
                "verify_iss": False,
            },
        )
    except jwt.ExpiredSignatureError as e:
        raise GoogleTokenError("トークンの有効期限が切れています") from e
    except jwt.InvalidAudienceError as e:
        raise GoogleTokenError("トークンの aud が一致しません") from e
    except jwt.InvalidTokenError as e:  # 署名不一致・改ざん・必須クレーム欠落など
        raise GoogleTokenError(f"トークンが無効です: {e}") from e

    # iss を許容値のいずれかに一致するか検証（別プロバイダ偽装を防ぐ）。
    iss = payload.get("iss", "")
    if iss not in ALLOWED_ISS:
        raise GoogleTokenError(f"トークンの iss が Google ではありません: {iss}")

    # 主体キー: sub（Google アカウントの安定した一意 ID）。
    sub = payload.get("sub")
    if not sub:
        raise GoogleTokenError("トークンに sub が含まれていません")

    name = payload.get("name")

    logger.info(
        "Google トークン検証成功: sub=%s name=%s",
        sub,
        name if name else "(なし)",
    )

    return GoogleClaims(sub=str(sub), name=name)
