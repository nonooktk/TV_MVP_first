"""アルバム一覧・最新取得・削除ルーター。

docs/api/openapi.yaml の /albums, /albums/latest, /albums/{album_id}（DELETE）に対応する。
albums は family_id を直接持たず call_id 経由（albums.call_id -> calls.family_id）で
家族に紐づく。
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_blob_service, get_db, require_device, require_family
from app.api.media import _album_to_response
from app.core.paths import call_prefix, thumb_key
from app.db.models import Album, Call, Device, Memory, User
from app.schemas import AlbumList, AlbumPhoto, AlbumResponse
from app.services.blob import BlobService

router = APIRouter(prefix="/albums", tags=["albums"])

# 一覧に含めるステータス（status=all のとき）。
_LIST_STATUSES = ("awaiting_selection", "generating", "ready")


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
    status_filter: str = Query("all", alias="status"),
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
    blob: BlobService = Depends(get_blob_service),
) -> AlbumList:
    """家族の閲覧一覧を返す（作成日降順・カーソルページング）。

    - status=all（既定）: awaiting_selection / generating / ready をすべて返す。
      **契約変更（v0.5.0）: 従来は ready のみ**。
    - status=<単一値>: 指定ステータスのみ返す。
    各要素は確定5枚（awaiting_selection では空配列）・status・presented_at・
    collage_sas_url（ready かつ存在時）を含む（N+1解消・進捗可視化）。
    """
    if limit < 1 or limit > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_limit", "message": "limit は 1〜100 で指定してください"},
        )

    if status_filter == "all":
        statuses = list(_LIST_STATUSES)
    elif status_filter in _LIST_STATUSES:
        statuses = [status_filter]
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "invalid_status",
                "message": "status は all / awaiting_selection / generating / ready のいずれか",
            },
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
        .where(Call.family_id == user.family_id, Album.status.in_(statuses))
        .order_by(Album.created_at.desc())
        .offset(offset)
        .limit(limit + 1)  # 次ページ有無の判定用に1件多く取る
    )
    rows = db.scalars(stmt).all()

    has_more = len(rows) > limit
    page = rows[:limit]

    # 確定5枚の memory を一括取得して N+1 を避ける（ページ内の全 selected_memory_ids）。
    all_selected_ids: list[UUID] = []
    for album in page:
        for x in album.selected_memory_ids or []:
            all_selected_ids.append(UUID(x))
    mem_by_id: dict[UUID, Memory] = {}
    if all_selected_ids:
        for m in db.scalars(
            select(Memory).where(Memory.id.in_(all_selected_ids))
        ).all():
            mem_by_id[m.id] = m

    items: list[AlbumResponse] = []
    for album in page:
        video_sas = (
            blob.view_sas_url(album.video_storage_key)
            if album.video_storage_key
            else None
        )
        collage_sas = (
            blob.view_sas_url(album.collage_storage_key)
            if album.status == "ready" and album.collage_storage_key
            else None
        )
        photos = _build_photos(album, mem_by_id, blob, user.family_id)
        items.append(
            _album_to_response(
                album,
                video_sas_url=video_sas,
                collage_sas_url=collage_sas,
                photos=photos,
            )
        )

    next_cursor = str(offset + limit) if has_more else None
    return AlbumList(items=items, next_cursor=next_cursor)


def _build_photos(
    album: Album,
    mem_by_id: dict[UUID, Memory],
    blob: BlobService,
    family_id: UUID,
) -> list[AlbumPhoto]:
    """album の確定5枚（順序保持）を AlbumPhoto 群へ変換する。

    awaiting_selection（selected_memory_ids が空）では空配列。
    thumb はパス規約から導出して SAS を発行する（存在チェックはしない。
    未生成時はフロントが sas_url にフォールバックする）。
    """
    photos: list[AlbumPhoto] = []
    for x in album.selected_memory_ids or []:
        mid = UUID(x)
        mem = mem_by_id.get(mid)
        if mem is None:
            # 参照先が消えている場合はスキップ（データの穴。表示は縮退）。
            continue
        # thumb は family_id/call_id/memory_id から導出する
        # （family_id は認証ユーザーの家族＝全アルバム共通。lazy load を避ける）。
        tkey = thumb_key(family_id, mem.call_id, mem.id)
        photos.append(
            AlbumPhoto(
                memory_id=mem.id,
                thumb_sas_url=blob.view_sas_url(tkey),
                sas_url=blob.view_sas_url(mem.storage_key),
                captured_at=mem.captured_at,
            )
        )
    return photos


@router.delete("/{album_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_album(
    album_id: UUID,
    user: User = Depends(require_family),
    db: Session = Depends(get_db),
    blob: BlobService = Depends(get_blob_service),
) -> Response:
    """アルバムを完全削除する（アプリ機能。Azureリソースの削除ではない）。

    認可: 家族 Bearer かつ role=owner のみ（viewer は 403）。
    削除対象:
      ① album 行
      ② 動画 Blob 全バージョン（albums/v*.mp4）
      ③ コラージュ Blob（albums/collage_v*.jpg）
      ④ 確定5枚の memories 行とその Blob（candidates/ と thumbs/）
    音声スニペット（snippets/）と call 行は残す。
    Blob 削除は存在しないものをスキップ（冪等）。応答 204。
    """
    # 認可: owner のみ（viewer は 403）。
    if user.role != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "削除は owner のみ実行できます"},
        )

    album = db.get(Album, album_id)
    if album is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "アルバムが見つかりません"},
        )

    call = db.get(Call, album.call_id)
    if call is None or call.family_id != user.family_id:
        # 帰属しないアルバムは存在を秘匿して 404。
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "アルバムが見つかりません"},
        )

    family_id = call.family_id
    call_id = call.id
    prefix = call_prefix(family_id, call_id)

    # ② 動画 Blob 全バージョン（albums/v*.mp4）。collage_v... は別プレフィックスなので巻き込まない。
    blob.delete_prefix(f"{prefix}albums/v")
    # ③ コラージュ Blob 全バージョン（albums/collage_v*.jpg）。
    blob.delete_prefix(f"{prefix}albums/collage_v")

    # ④ 確定5枚の memories 行とその Blob（candidates/ と thumbs/）。
    selected_ids = [UUID(x) for x in (album.selected_memory_ids or [])]
    if selected_ids:
        mems = db.scalars(select(Memory).where(Memory.id.in_(selected_ids))).all()
        for mem in mems:
            # candidates/ の原画像（memories.storage_key）。
            blob.delete_blob(mem.storage_key)
            # 対応する thumbs/。
            blob.delete_blob(thumb_key(family_id, call_id, mem.id))
            db.delete(mem)

    # ① album 行。
    db.delete(album)
    db.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)
