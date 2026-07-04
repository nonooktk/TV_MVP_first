"""ワーカー第1段: 候補スコアリング（score ジョブ）。

通話中に集まった写真候補に対してスコアリングと無表情ゲート判定を行い、
album（awaiting_selection）を作成して候補ランキングを提示する。
提示と同時に、5分自動確定用の auto_confirm メッセージを可視化遅延で投函する。

契約:
- スコア式:  score = 0.6 * rms_rise正規化 + 0.4 * face_score
  - rms_rise の正規化は候補内 min-max（全候補同値なら 0.5）。
  - metadata に欠損があれば各項 0.0 とみなす。
- 無表情ゲート: metadata.face_score < FACE_GATE_THRESHOLD の候補は score を 0 にする。
- 冪等 skip: 対象 call に album が存在し presented_at 記録済みなら skip。
- 提示: album を status=awaiting_selection・presented_at=now で作成し、
  auto_confirm を可視化遅延 AUTO_CONFIRM_DELAY_SECONDS 秒で投函する。

参照: docs/data-contract.md §3/§4, docs/detection-params.md
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Album, Memory

logger = logging.getLogger("worker.stage1")

# --- チューニング定数 ---------------------------------------------------------

# 無表情ゲートの閾値。metadata.face_score がこの値未満の候補は score を 0 にする。
# 初期値。精度チューニングは検収対象外（docs/detection-params.md の趣旨に従う）。
FACE_GATE_THRESHOLD = 0.1

# スコア式の重み（rms_rise 正規化 : face_score = 0.6 : 0.4）。
_W_RMS = 0.6
_W_FACE = 0.4


def _auto_confirm_delay_seconds() -> int:
    """auto_confirm メッセージの可視化遅延（秒）。

    既定は 300 秒（data-contract.md §4）。デモ・テスト短縮用に
    環境変数 AUTO_CONFIRM_DELAY_SECONDS で上書きできる。
    """
    raw = os.environ.get("AUTO_CONFIRM_DELAY_SECONDS")
    if raw is None:
        return 300
    try:
        return int(raw)
    except ValueError:
        logger.warning("AUTO_CONFIRM_DELAY_SECONDS が不正: %r。既定300を使う", raw)
        return 300


def _as_float(value: object) -> float | None:
    """metadata 値を float へ。数値でなければ None を返す。"""
    if isinstance(value, bool):  # bool は int のサブクラスなので明示除外
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def compute_scores(memories: list[Memory]) -> dict[UUID, float]:
    """写真候補群のスコアを算出して {memory_id: score} を返す（純関数・DB非依存）。

    - rms_rise は候補内 min-max 正規化（全候補同値なら 0.5）。欠損は 0.0 とみなす。
    - face_score は metadata から取得（欠損は 0.0）。
    - score = 0.6 * rms_rise正規化 + 0.4 * face_score。
    - 無表情ゲート: face_score < FACE_GATE_THRESHOLD の候補は score を 0 にする。
    """
    if not memories:
        return {}

    # rms_rise を収集（欠損は 0.0）。
    rms_values: dict[UUID, float] = {}
    for m in memories:
        meta = m.meta_ or {}
        rms = _as_float(meta.get("rms_rise"))
        rms_values[m.id] = rms if rms is not None else 0.0

    rms_min = min(rms_values.values())
    rms_max = max(rms_values.values())
    rms_span = rms_max - rms_min

    scores: dict[UUID, float] = {}
    for m in memories:
        meta = m.meta_ or {}
        face = _as_float(meta.get("face_score"))
        face_score = face if face is not None else 0.0

        # rms_rise 正規化（全候補同値なら 0.5）。
        if rms_span == 0:
            rms_norm = 0.5
        else:
            rms_norm = (rms_values[m.id] - rms_min) / rms_span

        score = _W_RMS * rms_norm + _W_FACE * face_score

        # 無表情ゲート: 閾値未満なら 0 にする。
        if face_score < FACE_GATE_THRESHOLD:
            score = 0.0

        scores[m.id] = score

    return scores


def run(db: Session, call_id: str, queue) -> str | None:
    """score ジョブ本体。候補をスコアリングし album を提示する。

    Args:
        db: DB セッション。
        call_id: 対象通話 ID（文字列 UUID）。
        queue: auto_confirm を投函するキューサービス
            （enqueue_auto_confirm(album_id, delay_seconds) を持つ）。

    Returns:
        作成した album_id（文字列）。skip 時は None。
    """
    call_uuid = UUID(str(call_id))

    # 冪等 skip: album が存在し presented_at 記録済みなら skip。
    existing = db.scalars(
        select(Album).where(Album.call_id == call_uuid)
    ).first()
    if existing is not None and existing.presented_at is not None:
        logger.info("score skip: call=%s は提示済み", call_id)
        return None

    # 写真候補を取得。
    photos = db.scalars(
        select(Memory).where(
            Memory.call_id == call_uuid, Memory.type == "photo"
        )
    ).all()

    # スコアリング（無表情ゲート含む）。
    scores = compute_scores(list(photos))
    for m in photos:
        m.score = scores.get(m.id)

    now = datetime.now(timezone.utc)

    # album を作成（提示）。既存があれば presented_at を補完する。
    if existing is None:
        album = Album(
            call_id=call_uuid,
            status="awaiting_selection",
            presented_at=now,
        )
        db.add(album)
        db.flush()  # id 採番
    else:
        album = existing
        album.status = "awaiting_selection"
        album.presented_at = now

    db.commit()

    # 提示と同時に auto_confirm を可視化遅延で投函（data-contract.md §4）。
    delay = _auto_confirm_delay_seconds()
    queue.enqueue_auto_confirm(str(album.id), delay_seconds=delay)
    logger.info(
        "score 完了: call=%s album=%s 候補=%d 件 auto_confirm=%ds後",
        call_id,
        album.id,
        len(photos),
        delay,
    )
    return str(album.id)
