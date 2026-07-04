"""ワーカー第2段: ハイライト動画生成（render ジョブ）。

選択された5枚（順序保持）を Blob からダウンロードし、タイトル・キャプションを付与、
BGM（無ければ無音）を載せて FFmpeg でハイライト動画を生成、Blob へアップロードして
album を ready に更新する。未選択候補には delete_after タグを付与する。

冪等: album.status == generating のときのみ処理する（data-contract.md §3）。

参照: docs/data-contract.md §2/§3, docs/ffmpeg-commands.md
"""

from __future__ import annotations

import logging
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.paths import album_video_key, snippet_key
from app.db.models import Album, Call, Memory

from stages import ffmpeg_render
from stages.labels import get_label_provider

logger = logging.getLogger("worker.stage2")

# 対応する BGM 拡張子（先頭の1つを使う）。
_BGM_EXTS = (".mp3", ".m4a", ".wav")
# 未選択候補の delete_after 猶予（確定日時から7日。data-contract.md §2）。
_DELETE_AFTER_DAYS = 7


def _find_bgm(bgm_dir: Path) -> Path | None:
    """worker/assets/bgm/ から最初の音声ファイルを返す（無ければ None＝無音）。"""
    if not bgm_dir.is_dir():
        return None
    candidates = sorted(
        p for p in bgm_dir.iterdir()
        if p.is_file() and p.suffix.lower() in _BGM_EXTS
    )
    return candidates[0] if candidates else None


def run(db: Session, album_id: str, blob, *, bgm_dir: Path | None = None) -> bool:
    """render ジョブ本体。

    Args:
        db: DB セッション。
        album_id: 対象 album ID（文字列 UUID）。
        blob: WorkerBlobService 互換（download / upload / set_delete_after_tag）。
        bgm_dir: BGM ディレクトリ（既定は worker/assets/bgm/）。

    Returns:
        レンダリングした場合 True、skip した場合 False。
    """
    album_uuid = UUID(str(album_id))
    album = db.get(Album, album_uuid)
    if album is None:
        logger.warning("render skip: album=%s が存在しない", album_id)
        return False

    # 冪等 skip: generating のときのみ処理する。
    if album.status != "generating":
        logger.info(
            "render skip: album=%s status=%s（generating 以外）", album_id, album.status
        )
        return False

    call = db.get(Call, album.call_id)
    if call is None:
        logger.error("render: album=%s の call が見つからない", album_id)
        return False

    selected_ids = [UUID(x) for x in (album.selected_memory_ids or [])]
    if not selected_ids:
        logger.error("render: album=%s に選択メモリが無い", album_id)
        return False

    # 選択メモリを取得し、selected_memory_ids の順序どおりに並べる。
    mem_by_id = {
        m.id: m
        for m in db.scalars(
            select(Memory).where(Memory.id.in_(selected_ids))
        ).all()
    }
    ordered = [mem_by_id[mid] for mid in selected_ids if mid in mem_by_id]
    if not ordered:
        logger.error("render: album=%s の選択メモリが取得できない", album_id)
        return False

    family_id = call.family_id
    call_id = call.id

    if bgm_dir is None:
        # worker/assets/bgm/（このファイルは worker/stages/stage2_video.py）。
        bgm_dir = Path(__file__).resolve().parents[1] / "assets" / "bgm"

    with tempfile.TemporaryDirectory(prefix="tvmvp-render-") as tmp:
        tmpdir = Path(tmp)

        # 1) 選択画像を順序どおりダウンロード。
        photo_paths: list[Path] = []
        for i, mem in enumerate(ordered, start=1):
            data = blob.download(mem.storage_key)
            p = tmpdir / f"photo{i}.jpg"
            p.write_bytes(data)
            photo_paths.append(p)

        # 2) タイトル・キャプション（既にユーザー指定があれば上書きしない）。
        call_date = call.started_at or call.created_at or datetime.now(timezone.utc)
        labels = get_label_provider().generate(
            call_date, len(photo_paths), photo_paths=photo_paths
        )
        if not album.title:
            album.title = labels.title
        if not album.caption:
            album.caption = labels.caption

        # 3) BGM 選定（無ければ無音フォールバック）。
        bgm_path = _find_bgm(bgm_dir)
        album.bgm_track = bgm_path.name if bgm_path else None

        # 4) FFmpeg 実行（クロスフェード版→失敗時 concat）。
        version = album.version + 1
        output = tmpdir / f"v{version}.mp4"
        method = ffmpeg_render.render(photo_paths, bgm_path, output, tmpdir)
        logger.info("render: album=%s ffmpeg=%s bgm=%s", album_id, method, album.bgm_track)

        # 5) アップロード。
        video_key = album_video_key(family_id, call_id, version)
        blob.upload(video_key, output.read_bytes(), content_type="video/mp4")

        # 6) album 更新。
        album.video_storage_key = video_key
        album.version = version
        album.status = "ready"
        db.commit()

    # 7) 未選択候補に delete_after タグを付与する。
    _tag_unselected(db, blob, family_id, call_id, selected_set=set(selected_ids))

    logger.info("render 完了: album=%s version=%d key=%s", album_id, version, video_key)
    return True


def _tag_unselected(
    db: Session,
    blob,
    family_id: UUID,
    call_id: UUID,
    *,
    selected_set: set[UUID],
) -> None:
    """未選択の candidates/ と対応 snippets/ に delete_after タグを付与する。

    Azurite がタグ非対応の場合は WorkerBlobService 側で警告してスキップする。
    """
    delete_after = (
        datetime.now(timezone.utc) + timedelta(days=_DELETE_AFTER_DAYS)
    ).date().isoformat()

    # 通話内の全メモリのうち、未選択（status != selected）を対象にする。
    all_mem = db.scalars(
        select(Memory).where(Memory.call_id == call_id)
    ).all()
    tagged = 0
    skipped = 0
    for mem in all_mem:
        if mem.id in selected_set or mem.status == "selected":
            continue
        # candidates/ の Blob（memories.storage_key）。
        if blob.set_delete_after_tag(mem.storage_key, delete_after):
            tagged += 1
        else:
            skipped += 1
        # 対応する snippets/ にも付与（存在すれば）。
        snip = snippet_key(family_id, call_id, mem.id)
        blob.set_delete_after_tag(snip, delete_after)

    logger.info(
        "delete_after タグ: call=%s tagged=%d skipped=%d after=%s",
        call_id,
        tagged,
        skipped,
        delete_after,
    )
