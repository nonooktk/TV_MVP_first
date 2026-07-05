"""通話管理ルーター。

docs/api/openapi.yaml の /calls, /calls/incoming, /calls/{call_id}/answer,
/calls/{call_id}/end に対応する。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import (
    get_agora_provider,
    get_db,
    require_device,
    require_family,
    require_family_or_device,
)
from app.db.models import Call, Device, Family, User
from app.schemas import (
    AnswerResponse,
    CallResponse,
    CreateCallRequest,
    IncomingStatus,
)
from app.services.agora import UID_ELDER, AgoraTokenProvider

router = APIRouter(prefix="/calls", tags=["calls"])

# 着信の失効期限（秒）。status=calling でもこの時間を過ぎた発信は着信として返さない
# （放置された calling が待受ポーリングに拾われ続けるのを防ぐ。既知課題#1 対応・M1）。
INCOMING_TTL_SECONDS = 120


@router.post("", response_model=CallResponse, status_code=status.HTTP_201_CREATED)
def create_call(
    body: CreateCallRequest,
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
) -> CallResponse:
    """発信・通話を作成する（家族側）。channel_name はサーバ生成。

    device_id は省略可能（既知課題#5 対応・2026-07-05）:
    - 省略時: 当該家族の status=active なデバイスへ自動解決する。
      複数件あれば最新 registered_at（NULL は最古扱い）を採用。
      0件なら 404 code="no_active_device"。
    - 明示指定時: 従来どおり存在・帰属（404）と active（400）を検証する。
    """
    if body.device_id is not None:
        device = db.get(Device, body.device_id)
        if device is None or device.family_id != user.family_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"code": "not_found", "message": "デバイスが見つかりません"},
            )
        if device.status != "active":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "device_not_active", "message": "デバイスが有効ではありません"},
            )
    else:
        device = db.scalars(
            select(Device)
            .where(
                Device.family_id == user.family_id,
                Device.status == "active",
            )
            .order_by(Device.registered_at.desc().nulls_last())
        ).first()
        if device is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "no_active_device",
                    "message": "登録済みのデバイスがありません。相手の設定から登録してください",
                },
            )

    call = Call(
        family_id=user.family_id,
        device_id=device.id,
        caller_user_id=user.id,
        channel_name=f"ch-{uuid4().hex[:12]}",
        status="calling",
    )
    db.add(call)
    db.commit()
    db.refresh(call)
    return CallResponse(
        id=call.id,
        family_id=call.family_id,
        device_id=call.device_id,
        channel_name=call.channel_name,
        status=call.status,
        started_at=call.started_at,
        ended_at=call.ended_at,
    )


@router.get("/incoming", response_model=IncomingStatus)
def poll_incoming_call(
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
) -> IncomingStatus:
    """高齢者側の着信状態をポーリングで取得する。

    status=calling かつ作成から INCOMING_TTL_SECONDS（120秒）以内の通話のみ
    着信として返す（古い calling は失効扱い）。
    """
    threshold = datetime.now(timezone.utc) - timedelta(seconds=INCOMING_TTL_SECONDS)
    call = db.scalars(
        select(Call)
        .where(
            Call.device_id == device.id,
            Call.status == "calling",
            Call.created_at >= threshold,
        )
        .order_by(Call.created_at.desc())
    ).first()
    if call is None:
        return IncomingStatus(incoming=False)

    family = db.get(Family, call.family_id)
    return IncomingStatus(
        incoming=True,
        call_id=call.id,
        family_name=family.name if family else None,
    )


@router.post("/{call_id}/answer", response_model=AnswerResponse)
def answer_call(
    call_id: UUID,
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
    agora: AgoraTokenProvider = Depends(get_agora_provider),
) -> AnswerResponse:
    """通話に応答する（「でる」）。status=active・started_at 記録＋トークン発行。"""
    call = db.get(Call, call_id)
    if call is None or call.device_id != device.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "通話が見つかりません"},
        )
    if call.status != "calling":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "not_calling", "message": "着信中の通話ではありません"},
        )

    call.status = "active"
    call.started_at = datetime.now(timezone.utc)
    db.commit()

    # uid ルール: 高齢者=2（UID_ELDER）。M2 で「uid=2 の高齢者ストリームに検知を接続する」。
    tok = agora.issue(call.channel_name, uid=UID_ELDER)
    return AnswerResponse(
        token=tok.token,
        channel_name=tok.channel_name,
        uid=tok.uid,
        expires_at=tok.expires_at,
        app_id=agora.app_id,
    )


@router.post("/{call_id}/end", response_model=CallResponse)
def end_call(
    call_id: UUID,
    auth: tuple[User | None, Device | None] = Depends(require_family_or_device),
    db: Session = Depends(get_db),
) -> CallResponse:
    """通話を明示的に終了する（契約変更②・既知課題#1 対応・M1）。

    家族（Bearer）・高齢者デバイス（X-Device-Token）のどちらからでも呼べる。
    status=ended・ended_at を記録する。既に ended の場合は何もせず 200（冪等）。
    media/register による ended 遷移（コア②の同期経路）はこれまで通り変更しない。
    """
    user, device = auth
    call = db.get(Call, call_id)
    # 呼び出し元の帰属確認（家族: family_id 一致 / デバイス: device_id 一致）
    if (
        call is None
        or (user is not None and call.family_id != user.family_id)
        or (device is not None and call.device_id != device.id)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "通話が見つかりません"},
        )

    if call.status != "ended":
        call.status = "ended"
        call.ended_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(call)

    return CallResponse(
        id=call.id,
        family_id=call.family_id,
        device_id=call.device_id,
        channel_name=call.channel_name,
        status=call.status,
        started_at=call.started_at,
        ended_at=call.ended_at,
    )
