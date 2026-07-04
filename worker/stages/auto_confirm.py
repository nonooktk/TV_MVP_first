"""auto_confirm ジョブ: 5分無選択での自動確定。

候補提示から可視化遅延後に取り出される時限メッセージ。album.status が
awaiting_selection のままなら上位5枚（スコア順）で自動確定し、
status を generating へ遷移させて render を投函する。
家族が既に選択確定済みなら何もしない（冪等）。

参照: docs/data-contract.md §3/§4
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Album, Memory

logger = logging.getLogger("worker.auto_confirm")

# 自動確定で採用する最大枚数。
_MAX_SELECT = 5


def run(db: Session, album_id: str, queue) -> bool:
    """auto_confirm ジョブ本体。

    Args:
        db: DB セッション。
        album_id: 対象 album ID（文字列 UUID）。
        queue: render を投函するキューサービス（enqueue_render を持つ）。

    Returns:
        自動確定した場合 True、skip した場合 False。
    """
    album_uuid = UUID(str(album_id))
    album = db.get(Album, album_uuid)
    if album is None:
        logger.warning("auto_confirm skip: album=%s が存在しない", album_id)
        return False

    # 冪等 skip: awaiting_selection 以外なら家族が選択済み（またはレンダ済み）。
    if album.status != "awaiting_selection":
        logger.info(
            "auto_confirm skip: album=%s status=%s（家族が選択済み）",
            album_id,
            album.status,
        )
        return False

    # 写真候補をスコア降順（None は末尾）で並べ、上位5枚を採用する。
    photos = db.scalars(
        select(Memory).where(
            Memory.call_id == album.call_id, Memory.type == "photo"
        )
    ).all()
    photos_sorted = sorted(
        photos, key=lambda m: (m.score is None, -(m.score or 0.0))
    )
    selected = photos_sorted[:_MAX_SELECT]  # 5枚未満なら在る分だけ

    if not selected:
        logger.warning(
            "auto_confirm: album=%s に写真候補が無いため確定できない", album_id
        )
        return False

    selected_ids = [m.id for m in selected]
    selected_set = set(selected_ids)

    # memories の status 更新（採用=selected、他=candidate）。
    for m in photos:
        m.status = "selected" if m.id in selected_set else "candidate"

    # album 更新（自動確定 → generating へ遷移。data-contract.md §4 手順4）。
    album.selected_memory_ids = [str(mid) for mid in selected_ids]
    album.confirmed_at = datetime.now(timezone.utc)
    album.auto_confirmed = True
    album.status = "generating"

    db.commit()

    # render 投函。
    queue.enqueue_render(str(album.id))
    logger.info(
        "auto_confirm 完了: album=%s 採用=%d 枚 → generating", album_id, len(selected_ids)
    )
    return True
