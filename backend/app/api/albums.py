"""アルバム一覧・最新取得ルーター。

docs/api/openapi.yaml の /albums, /albums/latest に対応する。
albums は family_id を直接持たず call_id 経由（albums.call_id -> calls.family_id）で
家族に紐づく。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_blob_service, get_db, require_device, require_family
from app.api.media import _album_to_response
from app.db.models import Album, Call, Device, User
from app.schemas import AlbumList, AlbumResponse
from app.services.blob import BlobService

router = APIRouter(prefix="/albums", tags=["albums"])


@router.get("/latest", response_model=AlbumResponse)
def get_latest_album(
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
    blob: BlobService = Depends(get_blob_service),
) -> AlbumResponse:
    """高齢者待受用の最新 ready ハイライトを取得する（video_sas_url 付き）。"""
    # デバイスの家族の通話に紐づく ready アルバムの最新1件。
    album = db.scalars(
        select(Album)
        .join(Call, Album.call_id == Call.id)
        .where(Call.family_id == device.family_id, Album.status == "ready")
        .order_by(Album.created_at.desc())
    ).first()
    if album is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "閲覧可能なアルバムがありません"},
        )

    video_sas = (
        blob.view_sas_url(album.video_storage_key)
        if album.video_storage_key
        else None
    )
    return _album_to_response(album, video_sas_url=video_sas)


@router.get("", response_model=AlbumList)
def list_albums(
    limit: int = 20,
    cursor: str | None = None,
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
    blob: BlobService = Depends(get_blob_service),
) -> AlbumList:
    """家族の閲覧一覧を返す（ready のみ・作成日降順・カーソルページング）。"""
    if limit < 1 or limit > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_limit", "message": "limit は 1〜100 で指定してください"},
        )

    # cursor は単純な offset（文字列）として扱う（openapi のカーソル契約に整合）。
    offset = 0
    if cursor:
        try:
            offset = int(cursor)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "invalid_cursor", "message": "cursor が不正です"},
            )

    stmt = (
        select(Album)
        .join(Call, Album.call_id == Call.id)
        .where(Call.family_id == user.family_id, Album.status == "ready")
        .order_by(Album.created_at.desc())
        .offset(offset)
        .limit(limit + 1)  # 次ページ有無の判定用に1件多く取る
    )
    rows = db.scalars(stmt).all()

    has_more = len(rows) > limit
    page = rows[:limit]

    items: list[AlbumResponse] = []
    for album in page:
        video_sas = (
            blob.view_sas_url(album.video_storage_key)
            if album.video_storage_key
            else None
        )
        items.append(_album_to_response(album, video_sas_url=video_sas))

    next_cursor = str(offset + limit) if has_more else None
    return AlbumList(items=items, next_cursor=next_cursor)
