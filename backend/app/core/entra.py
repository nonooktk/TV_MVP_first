"""Entra ID（Microsoft Entra External / 個人 Microsoft アカウント）JWT 検証。

家族側ログインの本実装。フロント（MSAL・SPA/PKCE）が取得した v2.0 アクセストークンを
Authorization: Bearer で受け取り、Microsoft の公開鍵（JWKS）で署名検証する。

二段構え:
- `ENTRA_CLIENT_ID` が空（アプリ登録未作成）なら Entra 検証は行わず、この経路は使わない
  （deps 側で dev トークンのみを通す）。
- `ENTRA_CLIENT_ID` が設定されていれば、dev トークン以外の Bearer を Entra JWT として検証する。

対象は「個人 Microsoft アカウント＋任意テナント」（sign-in audience =
AzureADandPersonalMicrosoftAccount）。共通エンドポイント `common` を使うため tid（テナントID）は
可変で、個人アカウントは consumers テナント（9188040d-6c67-4c5b-b112-36a304b66dad）になる。
iss は `https://login.microsoftonline.com/{tid}/v2.0` 形式であることを構造で検証する
（特定テナントには固定しない＝マルチテナント）。

依存: pyjwt[crypto]（署名検証に cryptography が必要）。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import jwt
from jwt import PyJWKClient

logger = logging.getLogger(__name__)

# Microsoft 共通メタデータ（マルチテナント＋個人 MSA 対応の JWKS エンドポイント）。
# common の discovery keys は全テナント・個人アカウントの署名鍵を含む。
JWKS_URL = "https://login.microsoftonline.com/common/discovery/v2.0/keys"

# iss の許容パターン。tid は可変（マルチテナント＋個人 MSA の consumers を含む）なので
# テナント部分は UUID を許容する。末尾 /v2.0 まで固定して他プロバイダの偽装を防ぐ。
_ISS_PATTERN = re.compile(
    r"^https://login\.microsoftonline\.com/"
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/v2\.0$"
)

# 個人 Microsoft アカウントのテナント（consumers）。iss の tid がこの値でも許容する
# （上の UUID パターンに含まれるため追加のホワイトリストは不要だが、意図を明示するために残す）。
CONSUMERS_TID = "9188040d-6c67-4c5b-b112-36a304b66dad"

# スコープ（scp）に含まれることを確認する値（存在すれば確認・無ければ通す）。
EXPECTED_SCOPE = "access_as_user"


class EntraTokenError(Exception):
    """Entra JWT の検証に失敗したことを表す例外。deps 側で 401 に変換する。"""


@dataclass(frozen=True)
class EntraClaims:
    """検証済みトークンから取り出す主体情報。

    - auth_id: 主体キー。oid（無ければ sub）。users.auth_id に対応する。
    - name: 表示名（あれば）。users に name カラムが無いため保存はせずログ用途。
    - tid: テナントID（ログ用途）。
    """

    auth_id: str
    name: str | None
    tid: str | None


# モジュール内で JWKS クライアントを1つ保持し、鍵をキャッシュする。
# PyJWKClient は kid 解決・鍵のキャッシュ・（キャッシュミス時の）再取得を内部で行う。
_jwk_client: PyJWKClient | None = None


def _get_jwk_client() -> PyJWKClient:
    """JWKS クライアント（プロセス内シングルトン）を返す。

    PyJWKClient は取得した鍵をキャッシュし、未知の kid（鍵ローテーション後など）を
    受け取った際は JWKS を取り直す。lifetime=... でキャッシュ有効期間を持たせる。
    """
    global _jwk_client
    if _jwk_client is None:
        _jwk_client = PyJWKClient(JWKS_URL, cache_keys=True, lifespan=3600)
    return _jwk_client


def verify_entra_token(token: str, client_id: str) -> EntraClaims:
    """Entra ID の v2.0 アクセストークンを検証し、主体情報を返す。

    検証項目:
    - 署名: JWKS（common）から kid に対応する公開鍵を解決し RS256 で検証。
    - exp: 期限切れは失敗（pyjwt が自動検証）。
    - aud: `api://{client_id}` または `{client_id}` のいずれか。
    - iss: `https://login.microsoftonline.com/{tid}/v2.0` 形式（tid 可変）。
    - scp: access_as_user が含まれること（scp が存在する場合のみ確認）。

    Raises:
        EntraTokenError: いずれかの検証に失敗した場合。
    """
    if not client_id:
        # 呼び出し側の実装ミス（ENTRA_CLIENT_ID 空なら本関数を呼ばない設計）。
        raise EntraTokenError("ENTRA_CLIENT_ID が未設定です")

    # aud は api://{client_id}（scope api://{id}/access_as_user のリソース）と
    # 素の {client_id} の双方を許容する（テナント設定により応答が異なるため）。
    allowed_aud = [f"api://{client_id}", client_id]

    try:
        signing_key = _get_jwk_client().get_signing_key_from_jwt(token)
    except Exception as e:  # noqa: BLE001  # 鍵解決失敗（不正な形・未知 kid・取得失敗）
        raise EntraTokenError(f"署名鍵の解決に失敗しました: {e}") from e

    try:
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=allowed_aud,
            options={
                "require": ["exp", "aud", "iss"],
                "verify_aud": True,
                "verify_exp": True,
                "verify_signature": True,
                # iss は形式（tid 可変）で検証するため pyjwt の完全一致検証は使わない。
                "verify_iss": False,
            },
        )
    except jwt.ExpiredSignatureError as e:
        raise EntraTokenError("トークンの有効期限が切れています") from e
    except jwt.InvalidAudienceError as e:
        raise EntraTokenError("トークンの aud が一致しません") from e
    except jwt.InvalidTokenError as e:  # 署名不一致・改ざん・必須クレーム欠落など
        raise EntraTokenError(f"トークンが無効です: {e}") from e

    # iss を形式で検証（マルチテナント＋個人 MSA: tid 可変）。
    iss = payload.get("iss", "")
    if not _ISS_PATTERN.match(iss):
        raise EntraTokenError(f"トークンの iss が想定形式ではありません: {iss}")

    # scp（スコープ）が存在すれば access_as_user を確認する。
    # v2.0 アクセストークンでは scp は空白区切りの文字列。
    scp = payload.get("scp")
    if scp is not None:
        scopes = scp.split() if isinstance(scp, str) else list(scp)
        if EXPECTED_SCOPE not in scopes:
            raise EntraTokenError(
                f"必要なスコープ {EXPECTED_SCOPE} がトークンに含まれていません"
            )

    # 主体キー: oid（テナント横断で安定）優先、無ければ sub。
    auth_id = payload.get("oid") or payload.get("sub")
    if not auth_id:
        raise EntraTokenError("トークンに oid / sub が含まれていません")

    name = payload.get("name")
    tid = payload.get("tid")

    logger.info(
        "Entra トークン検証成功: auth_id=%s tid=%s name=%s",
        auth_id,
        tid,
        name if name else "(なし)",
    )

    return EntraClaims(auth_id=str(auth_id), name=name, tid=tid)
