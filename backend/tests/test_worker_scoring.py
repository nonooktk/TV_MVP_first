"""ワーカー第1段（score）のユニットテスト。

- スコアリング計算（rms_rise の min-max 正規化・face_score 重み付け）
- 無表情ゲート（face_score < 閾値 → score=0）
- 冪等 skip（提示済み album があれば何もしない）

Blob/FFmpeg は使わない。DB は既存 conftest のフィクスチャを再利用する。
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

# worker/ を import パスに追加する（backend/tests から見て ../../worker）。
_WORKER_ROOT = Path(__file__).resolve().parents[2] / "worker"
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

import io  # noqa: E402

from PIL import Image  # noqa: E402

from app.core.paths import thumb_key  # noqa: E402
from app.db.models import Album, Call, Device, Family, Memory, User  # noqa: E402
from stages import stage1_scoring  # noqa: E402


class _FakeQueue:
    """auto_confirm 投函を記録するだけのフェイク。"""

    def __init__(self) -> None:
        self.auto_confirm: list[tuple[str, int]] = []

    def enqueue_auto_confirm(self, album_id: str, delay_seconds: int = 300) -> None:
        self.auto_confirm.append((album_id, delay_seconds))


def _dummy_jpeg(w=1280, h=720) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (200, 80, 80)).save(buf, "JPEG", quality=90)
    return buf.getvalue()


class _ThumbBlob:
    """download はダミー JPEG、upload は記録するだけのフェイク Blob。"""

    def __init__(self, *, fail_keys: set | None = None) -> None:
        self.uploaded: dict[str, bytes] = {}
        self.fail_keys = fail_keys or set()

    def download(self, storage_key: str) -> bytes:
        if storage_key in self.fail_keys:
            raise RuntimeError("download failed (candidate not uploaded)")
        return _dummy_jpeg()

    def upload(self, storage_key: str, data: bytes, content_type=None) -> None:
        self.uploaded[storage_key] = data


def _make_call(db) -> Call:
    family = Family(name="テスト家族")
    db.add(family)
    db.flush()
    owner = User(family_id=family.id, role="owner", auth_id=f"o-{uuid4().hex[:6]}")
    db.add(owner)
    db.flush()
    device = Device(
        family_id=family.id, fixed_contact_user_id=owner.id, status="active"
    )
    db.add(device)
    db.flush()
    call = Call(
        family_id=family.id,
        device_id=device.id,
        caller_user_id=owner.id,
        channel_name="ch-test",
        status="ended",
    )
    db.add(call)
    db.flush()
    return call


def _add_photo(db, call, *, rms_rise=None, face_score=None) -> Memory:
    meta: dict = {}
    if rms_rise is not None:
        meta["rms_rise"] = rms_rise
    if face_score is not None:
        meta["face_score"] = face_score
    mem = Memory(
        call_id=call.id,
        type="photo",
        storage_key=f"families/x/calls/{call.id}/candidates/{uuid4()}.jpg",
        status="candidate",
        captured_at=datetime.now(timezone.utc),
        meta_=meta,
    )
    db.add(mem)
    db.flush()
    return mem


def test_compute_scores_normalization():
    """rms_rise が min-max 正規化され、face 重み 0.4 が加算される。"""
    # rms_rise: 0/5/10 → 正規化 0.0/0.5/1.0。face_score は全て 0.5（ゲート通過）。
    class M:
        def __init__(self, rms, face):
            self.id = uuid4()
            self.meta_ = {"rms_rise": rms, "face_score": face}

    m0, m1, m2 = M(0, 0.5), M(5, 0.5), M(10, 0.5)
    scores, gate_applied = stage1_scoring.compute_scores([m0, m1, m2])
    # face が全て 0.5（>=閾値）なのでゲート適用可。
    assert gate_applied is True
    # score = 0.6*rms_norm + 0.4*face
    assert abs(scores[m0.id] - (0.6 * 0.0 + 0.4 * 0.5)) < 1e-9
    assert abs(scores[m1.id] - (0.6 * 0.5 + 0.4 * 0.5)) < 1e-9
    assert abs(scores[m2.id] - (0.6 * 1.0 + 0.4 * 0.5)) < 1e-9


def test_compute_scores_all_same_rms_is_half():
    """rms_rise が全候補同値なら正規化は 0.5。"""
    class M:
        def __init__(self):
            self.id = uuid4()
            self.meta_ = {"rms_rise": 7, "face_score": 0.5}

    m = M()
    scores, gate_applied = stage1_scoring.compute_scores([m])
    assert gate_applied is True
    assert abs(scores[m.id] - (0.6 * 0.5 + 0.4 * 0.5)) < 1e-9


def test_compute_scores_missing_metadata_falls_back_to_rms_only():
    """metadata 全欠損（face 全 0）ではゲートを適用せず音圧のみで採点する。

    不具合2の再発防止: 表情信号が全滅（MediaPipe 停止など）でも候補が全滅せず、
    rms_rise で順位が付くこと（全欠損→rms 同値→正規化 0.5→score 0.3）。
    """
    class M:
        def __init__(self):
            self.id = uuid4()
            self.meta_ = {}

    a, b = M(), M()
    scores, gate_applied = stage1_scoring.compute_scores([a, b])
    # face 全 0 → max<閾値 → ゲート不適用（音圧のみ）。
    assert gate_applied is False
    # rms も全欠損（同値）→正規化 0.5 → score = 0.6*0.5 = 0.3。ゲートで潰れない。
    assert abs(scores[a.id] - 0.3) < 1e-9
    assert abs(scores[b.id] - 0.3) < 1e-9


def test_compute_scores_face_gate():
    """face_score < 0.1 の候補は score が 0 になる（無表情ゲート・適用可の場合）。"""
    class M:
        def __init__(self, rms, face):
            self.id = uuid4()
            self.meta_ = {"rms_rise": rms, "face_score": face}

    # passed の face=0.2 が閾値以上なので候補全体ではゲート適用可。
    # 高 rms でも gated の face が閾値未満なら 0。
    gated = M(10, 0.05)
    passed = M(0, 0.2)
    scores, gate_applied = stage1_scoring.compute_scores([gated, passed])
    assert gate_applied is True
    assert scores[gated.id] == 0.0
    assert scores[passed.id] > 0.0
    assert stage1_scoring.FACE_GATE_THRESHOLD == 0.1


def test_compute_scores_gate_bypass_when_all_faces_dead():
    """候補全体の max(face_score) が閾値未満ならゲートを適用せず音圧でランキングする。

    不具合2の中核: 実通話で face_score が全 0 でも、音圧の高い候補が上位に来る
    （全候補 score=0 で全滅しない）ことを保証する。
    """
    class M:
        def __init__(self, rms, face):
            self.id = uuid4()
            self.meta_ = {"rms_rise": rms, "face_score": face}

    lo = M(0, 0.0)   # 音圧最小
    hi = M(100, 0.0)  # 音圧最大・ただし face は死んでいる
    scores, gate_applied = stage1_scoring.compute_scores([lo, hi])
    assert gate_applied is False  # 表情死活 → ゲート不適用
    # 音圧のみで順位: hi > lo（どちらも 0 ではない）。
    assert scores[hi.id] > scores[lo.id]
    assert scores[hi.id] > 0.0


def test_run_creates_album_and_enqueues_auto_confirm(db):
    """run が album を awaiting_selection で作成し auto_confirm を投函する。"""
    call = _make_call(db)
    _add_photo(db, call, rms_rise=10, face_score=0.8)
    _add_photo(db, call, rms_rise=0, face_score=0.05)  # ゲート対象
    db.commit()

    queue = _FakeQueue()
    album_id = stage1_scoring.run(db, str(call.id), queue)

    assert album_id is not None
    album = db.get(Album, __import__("uuid").UUID(album_id))
    assert album.status == "awaiting_selection"
    assert album.presented_at is not None
    # auto_confirm が1件・既定 300 秒遅延で投函されている。
    assert len(queue.auto_confirm) == 1
    assert queue.auto_confirm[0][1] == 300
    # スコアが保存され、ゲート対象は 0。
    photos = db.query(Memory).filter(Memory.call_id == call.id).all()
    gated = [p for p in photos if p.meta_.get("face_score") == 0.05][0]
    assert gated.score == 0.0


def test_run_skip_when_already_presented(db):
    """提示済み album があれば skip（None を返す）。"""
    call = _make_call(db)
    _add_photo(db, call, rms_rise=1, face_score=0.5)
    album = Album(
        call_id=call.id,
        status="awaiting_selection",
        presented_at=datetime.now(timezone.utc),
    )
    db.add(album)
    db.commit()

    queue = _FakeQueue()
    result = stage1_scoring.run(db, str(call.id), queue)
    assert result is None
    assert queue.auto_confirm == []


def test_run_generates_thumbnails(db):
    """blob を渡すと各写真候補のサムネ（thumbs/{memory_id}.jpg）を生成する。"""
    call = _make_call(db)
    m1 = _add_photo(db, call, rms_rise=10, face_score=0.8)
    m2 = _add_photo(db, call, rms_rise=5, face_score=0.6)
    db.commit()

    queue = _FakeQueue()
    blob = _ThumbBlob()
    stage1_scoring.run(db, str(call.id), queue, blob)

    # 2枚ぶんのサムネがアップロードされる。
    k1 = thumb_key(call.family_id, call.id, m1.id)
    k2 = thumb_key(call.family_id, call.id, m2.id)
    assert k1 in blob.uploaded
    assert k2 in blob.uploaded
    # サムネは幅320px の JPEG。
    ti = Image.open(io.BytesIO(blob.uploaded[k1]))
    assert ti.size[0] == 320


def test_run_thumbnail_failure_is_skipped(db):
    """個々のサムネ生成失敗は警告スキップで、他候補・スコアリングは止めない。"""
    call = _make_call(db)
    m1 = _add_photo(db, call, rms_rise=10, face_score=0.8)
    m2 = _add_photo(db, call, rms_rise=5, face_score=0.6)
    db.commit()

    queue = _FakeQueue()
    # m1 の download を失敗させる。
    blob = _ThumbBlob(fail_keys={m1.storage_key})
    album_id = stage1_scoring.run(db, str(call.id), queue, blob)

    assert album_id is not None  # 提示は成立する
    k1 = thumb_key(call.family_id, call.id, m1.id)
    k2 = thumb_key(call.family_id, call.id, m2.id)
    assert k1 not in blob.uploaded  # 失敗ぶんは無し
    assert k2 in blob.uploaded  # 成功ぶんはある
    # auto_confirm も投函される（処理は完走）。
    assert len(queue.auto_confirm) == 1
