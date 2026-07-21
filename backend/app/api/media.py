"""メディア登録・アップロードSAS・候補・選択確定ルーター。

docs/api/openapi.yaml の /media/register, /media/upload-sas（追加）,
/calls/{call_id}/candidates, /calls/{call_id}/selection に対応する。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import (
    get_blob_service,
    get_db,
    get_queue_service,
    require_family,
)
from app.core.paths import call_prefix, thumb_key
from app.db.models import Album, Call, Memory, User
from app.schemas import (
    AlbumPhoto,
    AlbumResponse,
    Candidate,
    CandidateList,
    MediaRegisterRequest,
    MediaRegisterResponse,
    SelectionRequest,
    UploadSasItem,
    UploadSasRequest,
    UploadSasResponse,
)
from app.services.blob import BlobService
from app.services.queue import QueueService

router = APIRouter(tags=["media"])

# 自動確定の猶予（提示から5分）
_AUTO_CONFIRM_DELAY = timedelta(minutes=5)
# アップロードSASの有効期限（data-contract.md §2）
_UPLOAD_TTL = timedelta(hours=1)


def _owned_call(db: Session, call_id: UUID, user: User) -> Call:
    """認証ユーザーの家族に属する通話を取得する（無ければ404）。"""
    call = db.get(Call, call_id)
    if call is None or call.family_id != user.family_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "通話が見つかりません"},
        )
    return call


@router.post(
    "/media/register",
    response_model=MediaRegisterResponse,
    status_code=status.HTTP_201_CREATED,
)
def register_media(
    body: MediaRegisterRequest,
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
    queue: QueueService = Depends(get_queue_service),
) -> MediaRegisterResponse:
    """候補メディアを登録し、通話を終了扱いにして score ジョブを投函する。

    冪等性（多重同期対策）: 当該通話に album が既に存在し提示済み（presented_at あり）の
    場合、これは同期のリトライ／再同期による重複 register とみなす。候補が二重に
    増えて採点・提示が壊れるのを防ぐため、**新規メモリを追加せず**、既存の写真候補の
    memory_ids を返して 201 とする（score の再投函もしない。クライアントは 201 を受けて
    IndexedDB を掃除できる）。
    参照: docs/data-contract.md §3（冪等性）。
    """
    call = _owned_call(db, body.call_id, user)

    # F-10（SECURITY_REPORT_2026-07-19）対応: storage_key はサーバ側で必ず当該通話の
    # プレフィックス配下に限定する。クライアント申告の storage_key を無検証で保存すると、
    # 家族Bが自分の call に他家族プレフィックス（families/{家族A}/calls/.../xxx.jpg）の
    # memory を register できてしまい、GET /calls/{id}/candidates が同 storage_key の
    # read SAS を発行するため**他家族 Blob の read SAS を取得できる芽**が残る（F-1 の read 版）。
    # upload-sas と同じ call_prefix ヘルパで境界を固定し、越境 read の芽を根絶する。
    prefix = call_prefix(call.family_id, call.id)
    for item in body.items:
        key = item.storage_key
        # 空・プレフィックス外・相対（".." による遡上）を弾く。
        if not key or ".." in key or not key.startswith(prefix):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "invalid_storage_key",
                    "message": "storage_key は当該通話のプレフィックス配下である必要があります",
                },
            )

    # 既に提示済み album があるなら重複同期。候補を汚さずに既存 memory_ids を返す。
    existing_album = db.scalars(
        select(Album).where(Album.call_id == call.id)
    ).first()
    if existing_album is not None and existing_album.presented_at is not None:
        existing_ids = [
            m.id
            for m in db.scalars(
                select(Memory).where(Memory.call_id == call.id)
            ).all()
        ]
        return MediaRegisterResponse(memory_ids=existing_ids)

    memory_ids: list[UUID] = []
    for item in body.items:
        mem = Memory(
            call_id=call.id,
            type=item.type,
            storage_key=item.storage_key,
            status="candidate",
            captured_at=item.captured_at,
            meta_=item.metadata or {},
        )
        db.add(mem)
        db.flush()  # id 採番
        memory_ids.append(mem.id)

    # 通話が未終了なら終了扱いにする。
    if call.status != "ended":
        call.status = "ended"
        call.ended_at = datetime.now(timezone.utc)

    db.commit()

    # score ジョブ投函（data-contract.md §3）
    queue.enqueue_score(str(call.id))

    return MediaRegisterResponse(memory_ids=memory_ids)


@router.post("/media/upload-sas", response_model=UploadSasResponse)
def issue_upload_sas(
    body: UploadSasRequest,
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
    blob: BlobService = Depends(get_blob_service),
) -> UploadSasResponse:
    """当該通話プレフィックス限定の書き込みSAS URL群を返す（1時間）。"""
    call = _owned_call(db, body.call_id, user)

    prefix = call_prefix(call.family_id, call.id)
    items: list[UploadSasItem] = []
    for filename in body.filenames:
        # ファイル名をそのまま通話プレフィックス配下へ配置する。
        storage_key = f"{prefix}{filename}"
        url = blob.upload_sas_url(storage_key, call_prefix=prefix)
        items.append(
            UploadSasItem(filename=filename, storage_key=storage_key, upload_url=url)
        )

    expires_at = datetime.now(timezone.utc) + _UPLOAD_TTL
    return UploadSasResponse(items=items, expires_at=expires_at)


@router.get(
    "/calls/{call_id}/candidates",
    response_model=CandidateList,
)
def get_candidates(
    call_id: UUID,
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
    blob: BlobService = Depends(get_blob_service),
) -> CandidateList:
    """候補ランキングを返す（写真候補・スコア降順・rank付き・閲覧SAS 15分）。"""
    call = _owned_call(db, call_id, user)

    album = db.scalars(select(Album).where(Album.call_id == call.id)).first()
    if album is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "アルバム（候補）が未作成です"},
        )

    # 写真候補をスコア降順（None は末尾）で取得する。
    photos = db.scalars(
        select(Memory).where(Memory.call_id == call.id, Memory.type == "photo")
    ).all()
    photos_sorted = sorted(
        photos, key=lambda m: (m.score is None, -(m.score or 0.0))
    )

    auto_confirm_at = (
        album.presented_at + _AUTO_CONFIRM_DELAY if album.presented_at else None
    )

    candidates: list[Candidate] = []
    for rank, mem in enumerate(photos_sorted, start=1):
        # thumb はパス規約から導出して SAS を発行する（存在チェックはしない。
        # 未生成時はフロントが sas_url にフォールバックする）。
        tkey = thumb_key(call.family_id, call.id, mem.id)
        candidates.append(
            Candidate(
                id=mem.id,
                call_id=mem.call_id,
                type=mem.type,
                storage_key=mem.storage_key,
                score=mem.score,
                status=mem.status,
                captured_at=mem.captured_at,
                metadata=mem.meta_ or {},
                rank=rank,
                sas_url=blob.view_sas_url(mem.storage_key),
                thumb_sas_url=blob.view_sas_url(tkey),
            )
        )

    return CandidateList(
        album_id=album.id,
        presented_at=album.presented_at,
        auto_confirm_at=auto_confirm_at,
        candidates=candidates,
    )


@router.post(
    "/calls/{call_id}/selection",
    response_model=AlbumResponse,
)
def submit_selection(
    call_id: UUID,
    body: SelectionRequest,
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
    queue: QueueService = Depends(get_queue_service),
) -> AlbumResponse:
    """5枚選択を確定し、動画生成（render）へ回す。"""
    call = _owned_call(db, call_id, user)

    album = db.scalars(select(Album).where(Album.call_id == call.id)).first()
    if album is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "アルバム（候補）が未作成です"},
        )

    # 生成中は再実行不可（多重レンダリング防止）。
    if album.status == "generating":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "generating", "message": "動画生成中のため確定できません"},
        )

    # 選択された5件がこの通話の photo 候補であることを検証する。
    selected_ids = list(body.memory_ids)
    if len(set(selected_ids)) != 5:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_selection", "message": "重複のない5枚を指定してください"},
        )

    valid_photos = {
        m.id
        for m in db.scalars(
            select(Memory).where(Memory.call_id == call.id, Memory.type == "photo")
        ).all()
    }
    if not set(selected_ids).issubset(valid_photos):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "invalid_selection",
                "message": "この通話の写真候補ではない memory_id が含まれています",
            },
        )

    # memories の status 更新（選ばれた5=selected、他=candidate）。
    all_photos = db.scalars(
        select(Memory).where(Memory.call_id == call.id, Memory.type == "photo")
    ).all()
    selected_set = set(selected_ids)
    for mem in all_photos:
        mem.status = "selected" if mem.id in selected_set else "candidate"

    # album 更新（選択確定 → generating へ遷移。data-contract.md §3/§4 整合）。
    album.selected_memory_ids = [str(mid) for mid in selected_ids]
    album.confirmed_at = datetime.now(timezone.utc)
    album.auto_confirmed = False
    album.status = "generating"
    if body.title is not None:
        album.title = body.title
    if body.caption is not None:
        album.caption = body.caption

    db.commit()
    db.refresh(album)

    # render ジョブ投函（data-contract.md §3）。
    queue.enqueue_render(str(album.id))

    return _album_to_response(album)


def _album_to_response(
    album: Album,
    video_sas_url: str | None = None,
    collage_sas_url: str | None = None,
    photos: list[AlbumPhoto] | None = None,
) -> AlbumResponse:
    """Album モデルをレスポンススキーマへ変換する。"""
    selected = (
        [UUID(x) for x in album.selected_memory_ids]
        if album.selected_memory_ids
        else None
    )
    return AlbumResponse(
        id=album.id,
        call_id=album.call_id,
        status=album.status,
        selected_memory_ids=selected,
        title=album.title,
        caption=album.caption,
        bgm_track=album.bgm_track,
        video_storage_key=album.video_storage_key,
        video_sas_url=video_sas_url,
        collage_sas_url=collage_sas_url,
        version=album.version,
        presented_at=album.presented_at,
        confirmed_at=album.confirmed_at,
        auto_confirmed=album.auto_confirmed,
        photos=photos,
    )
