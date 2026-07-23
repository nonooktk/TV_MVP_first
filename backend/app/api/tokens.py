"""トークン発行ルーター（委託コア①連携）。

docs/api/openapi.yaml の /tokens/call, /tokens/speech に対応する。
Agora は設定（AGORA_APP_ID / AGORA_APP_CERTIFICATE）が揃っていれば Real、
欠けていれば Fake で発行する（M1）。Speech は Fake（A1 で差し替え）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import (
    get_agora_provider,
    get_db,
    get_speech_provider,
    require_family,
)
from app.db.models import Call, Device, User
from app.schemas import CallTokenRequest, CallTokenResponse, SpeechTokenResponse
from app.services.agora import UID_FAMILY, AgoraTokenProvider
from app.services.speech import SpeechTokenProvider

router = APIRouter(prefix="/tokens", tags=["tokens"])


@router.post("/call", response_model=CallTokenResponse)
def issue_call_token(
    body: CallTokenRequest,
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
    agora: AgoraTokenProvider = Depends(get_agora_provider),
) -> CallTokenResponse:
    """Agora 通話用トークンを発行する（家族側）。"""
    call = db.get(Call, body.call_id)
    if call is None or call.family_id != user.family_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "通話が見つかりません"},
        )
    # uid ルール: 家族=1（UID_FAMILY）。M2 で uid=2 の高齢者ストリームに検知を接続する。
    tok = agora.issue(call.channel_name, uid=UID_FAMILY)
    # 相手（高齢者側デバイス）の表示名を引く。未設定なら null（フロントはラベル非表示）。
    device = db.get(Device, call.device_id)
    remote_display_name = device.display_name if device else None
    return CallTokenResponse(
        token=tok.token,
        channel_name=tok.channel_name,
        uid=tok.uid,
        expires_at=tok.expires_at,
        app_id=agora.app_id,
        remote_display_name=remote_display_name,
    )


@router.post("/speech", response_model=SpeechTokenResponse)
def issue_speech_token(
    user: User = Depends(require_family),
    speech: SpeechTokenProvider = Depends(get_speech_provider),
) -> SpeechTokenResponse:
    """Azure Speech 用トークンを発行する（家族側）。"""
    tok = speech.issue()
    return SpeechTokenResponse(
        token=tok.token, region=tok.region, expires_at=tok.expires_at
    )
