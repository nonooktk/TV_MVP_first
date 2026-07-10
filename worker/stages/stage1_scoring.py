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

from app.core.paths import thumb_key
from app.db.models import Album, Call, Memory

from stages import images

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


def _gate_is_applicable(face_scores: list[float]) -> bool:
    """無表情ゲートを適用してよいか判定する（表情信号の死活チェック）。

    候補全体の max(face_score) がゲート閾値未満なら、表情検知が実質死んでいる
    （MediaPipe ロード失敗・全コマ顔なし等）とみなし、ゲートを適用しない。
    ゲートを適用すると全候補が 0 点になり、音圧トリガーで拾えた思い出まで全滅する
    ため、この場合は face を無視して rms_rise（音圧）のみでランキングする。

    - max(face_score) >= FACE_GATE_THRESHOLD: 少なくとも1枚は表情信号があるので適用可。
    - それ未満: 適用不可（fallback = 音圧のみ）。
    """
    if not face_scores:
        return False
    return max(face_scores) >= FACE_GATE_THRESHOLD


def _stream_of(m: Memory) -> str:
    """写真候補の取得元ストリーム（両側連写・Phase 2）。

    metadata.stream（"elder"/"family"）を返す。未設定（過去データ）や想定外値は
    "elder" 扱い（既存データとの後方互換＝声トリガー両側化以前は全て高齢者側映像だった）。
    """
    stream = (m.meta_ or {}).get("stream")
    return stream if stream in ("elder", "family") else "elder"


def _compute_scores_single_stream(
    memories: list[Memory],
) -> tuple[dict[UUID, float], bool]:
    """単一ストリーム内でスコアを算出する（rms_rise 正規化・無表情ゲートはこの群内で完結）。

    - rms_rise は **この群内** の min-max 正規化（全候補同値なら 0.5）。欠損は 0.0。
    - face_score は metadata から取得（欠損は 0.0）。
    - score = 0.6 * rms_rise正規化 + 0.4 * face_score。
    - 無表情ゲート: face_score < FACE_GATE_THRESHOLD の候補は score を 0 にする。
      ただし **この群の max(face_score) が閾値未満のときはゲートを適用しない**
      （表情信号が死活のため。音圧のみでランキングする）。
    """
    if not memories:
        return {}, False

    rms_values: dict[UUID, float] = {}
    face_by_id: dict[UUID, float] = {}
    for m in memories:
        meta = m.meta_ or {}
        rms = _as_float(meta.get("rms_rise"))
        rms_values[m.id] = rms if rms is not None else 0.0
        face = _as_float(meta.get("face_score"))
        face_by_id[m.id] = face if face is not None else 0.0

    rms_min = min(rms_values.values())
    rms_max = max(rms_values.values())
    rms_span = rms_max - rms_min

    gate_applied = _gate_is_applicable(list(face_by_id.values()))

    scores: dict[UUID, float] = {}
    for m in memories:
        face_score = face_by_id[m.id]
        if rms_span == 0:
            rms_norm = 0.5
        else:
            rms_norm = (rms_values[m.id] - rms_min) / rms_span
        score = _W_RMS * rms_norm + _W_FACE * face_score
        if gate_applied and face_score < FACE_GATE_THRESHOLD:
            score = 0.0
        scores[m.id] = score

    return scores, gate_applied


def compute_scores(
    memories: list[Memory],
) -> tuple[dict[UUID, float], bool]:
    """写真候補群のスコアを算出して ({memory_id: score}, gate_applied) を返す。

    純関数・DB非依存。

    【両側連写・Phase 2: ストリーム別ゲート／フォールバック】
    候補を metadata.stream（"elder"/"family"）でグループ分けし、rms_rise 正規化・無表情
    ゲート・音圧フォールバックを **ストリーム別に** 適用する。狙いは、高齢者側の写真
    （顔検知しない＝face_score=0）が、家族側の表情信号が生きていることを理由に無表情ゲートで
    全滅し、候補が家族側に独占されるのを防ぐこと。ストリーム別にすることで、

      - 高齢者側群: max(face)=0 < 閾値 → ゲート不適用 → 音圧（rms_rise）のみでランキング（全滅しない）。
      - 家族側群: 表情信号が生きていれば無表情ゲートを適用（従来どおり）。

    となり、両ストリームの候補が非ゼロのスコアで混在して返る（おすすめ上位はスコア順のまま）。
    返り値の第2要素 gate_applied は観測用で、**いずれかのストリームでゲートを適用したか**
    （any）を表す。ストリームが実質1つ（既存データ＝全て elder 扱い）のときは従来と同じ挙動。
    """
    if not memories:
        return {}, False

    # ストリーム別にグループ分けする（未設定は elder 扱い）。
    groups: dict[str, list[Memory]] = {}
    for m in memories:
        groups.setdefault(_stream_of(m), []).append(m)

    scores: dict[UUID, float] = {}
    any_gate_applied = False
    for stream_memories in groups.values():
        sub_scores, gate_applied = _compute_scores_single_stream(stream_memories)
        scores.update(sub_scores)
        any_gate_applied = any_gate_applied or gate_applied

    return scores, any_gate_applied


def run(db: Session, call_id: str, queue, blob=None) -> str | None:
    """score ジョブ本体。候補をスコアリングし album を提示する。

    Args:
        db: DB セッション。
        call_id: 対象通話 ID（文字列 UUID）。
        queue: auto_confirm を投函するキューサービス
            （enqueue_auto_confirm(album_id, delay_seconds) を持つ）。
        blob: WorkerBlobService 互換（download / upload）。サムネイル生成に使う。
            None のときはサムネ生成をスキップする（後方互換・テスト用）。

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
    scores, gate_applied = compute_scores(list(photos))
    for m in photos:
        m.score = scores.get(m.id)

    # ゲート適用可否を観測できるようにする（表情検知の死活）。
    # 適用不可＝候補全体で表情信号が閾値未満（MediaPipe 停止の疑い）→ 音圧のみで採点した。
    if not gate_applied and photos:
        face_max = max(
            (_as_float((m.meta_ or {}).get("face_score")) or 0.0) for m in photos
        )
        logger.warning(
            "無表情ゲートを適用せず（表情信号が死活・音圧のみで採点）: "
            "call=%s 候補=%d max_face_score=%.4f",
            call_id,
            len(photos),
            face_max,
        )

    # 各写真候補のサムネイル（幅320px・JPEG品質70）を生成してアップロードする。
    # 失敗は警告ログでスキップし、候補処理は止めない（軽量化はベストエフォート）。
    if blob is not None and photos:
        _generate_thumbnails(db, blob, call_uuid, list(photos))

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
        "score 完了: call=%s album=%s 候補=%d 件 gate=%s auto_confirm=%ds後",
        call_id,
        album.id,
        len(photos),
        "applied" if gate_applied else "bypassed(音圧のみ)",
        delay,
    )
    return str(album.id)


def _generate_thumbnails(
    db: Session, blob, call_uuid: UUID, photos: list[Memory]
) -> None:
    """写真候補のサムネイルを生成して Blob へアップロードする（ベストエフォート）。

    各候補の原画像（memories.storage_key）を download → 幅320px/JPEG品質70 の
    サムネへ縮小 → thumbs/{memory_id}.jpg へ upload する。
    個々の失敗（画像が壊れている・未アップロード等）は警告ログでスキップし、
    候補処理全体は止めない。
    """
    call = db.get(Call, call_uuid)
    if call is None:
        logger.warning("thumbnail: call=%s が見つからないためスキップ", call_uuid)
        return
    family_id = call.family_id

    generated = 0
    skipped = 0
    for mem in photos:
        try:
            data = blob.download(mem.storage_key)
            thumb = images.make_thumbnail(data)
            key = thumb_key(family_id, call_uuid, mem.id)
            blob.upload(key, thumb, content_type="image/jpeg")
            generated += 1
        except Exception as e:  # noqa: BLE001
            skipped += 1
            logger.warning(
                "サムネ生成に失敗（スキップ）: memory=%s key=%s err=%s",
                mem.id,
                mem.storage_key,
                e,
            )
    logger.info(
        "サムネ生成: call=%s generated=%d skipped=%d", call_uuid, generated, skipped
    )
