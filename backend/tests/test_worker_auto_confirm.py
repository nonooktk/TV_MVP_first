"""ワーカー auto_confirm のユニットテスト。

- 上位5枚（スコア降順）で自動確定し generating へ遷移・render 投函
- 5枚未満なら在る分だけ確定
- 冪等 skip（awaiting_selection 以外は何もしない）

Blob/FFmpeg は使わない。
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

_WORKER_ROOT = Path(__file__).resolve().parents[2] / "worker"
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from app.db.models import Album, Call, Device, Family, Memory, User  # noqa: E402
from stages import auto_confirm  # noqa: E402


class _FakeQueue:
    def __init__(self) -> None:
        self.render: list[str] = []

    def enqueue_render(self, album_id: str) -> None:
        self.render.append(album_id)


def _setup(db, *, n_photos: int, scores: list[float] | None = None) -> tuple[Call, Album, list[Memory]]:
    family = Family(name="テスト家族")
    db.add(family)
    db.flush()
    owner = User(family_id=family.id, role="owner", auth_id=f"o-{uuid4().hex[:6]}")
    db.add(owner)
    db.flush()
    device = Device(family_id=family.id, fixed_contact_user_id=owner.id, status="active")
    db.add(device)
    db.flush()
    call = Call(
        family_id=family.id,
        device_id=device.id,
        caller_user_id=owner.id,
        channel_name="ch",
        status="ended",
    )
    db.add(call)
    db.flush()

    mems: list[Memory] = []
    for i in range(n_photos):
        score = scores[i] if scores else float(i)
        mem = Memory(
            call_id=call.id,
            type="photo",
            storage_key=f"families/x/calls/{call.id}/candidates/{uuid4()}.jpg",
            status="candidate",
            score=score,
            captured_at=datetime.now(timezone.utc),
            meta_={},
        )
        db.add(mem)
        mems.append(mem)
    db.flush()

    album = Album(
        call_id=call.id,
        status="awaiting_selection",
        presented_at=datetime.now(timezone.utc),
    )
    db.add(album)
    db.commit()
    return call, album, mems


def test_auto_confirm_selects_top5(db):
    """8候補から上位5枚（スコア降順）で確定し generating へ遷移する。"""
    scores = [0.1, 0.9, 0.5, 0.8, 0.2, 0.7, 0.3, 0.95]  # 8枚
    call, album, mems = _setup(db, n_photos=8, scores=scores)

    queue = _FakeQueue()
    ok = auto_confirm.run(db, str(album.id), queue)
    assert ok is True

    db.refresh(album)
    assert album.status == "generating"
    assert album.auto_confirmed is True
    assert album.confirmed_at is not None
    assert len(album.selected_memory_ids) == 5

    # 期待される上位5スコア: 0.95,0.9,0.8,0.7,0.5。
    selected = [UUID(x) for x in album.selected_memory_ids]
    selected_scores = sorted(
        (m.score for m in mems if m.id in set(selected)), reverse=True
    )
    assert selected_scores == [0.95, 0.9, 0.8, 0.7, 0.5]
    # 先頭は最高スコア。
    assert mems[7].id == selected[0]  # score 0.95

    # 選ばれた5枚が selected、他は candidate。
    for m in db.query(Memory).filter(Memory.call_id == call.id).all():
        if m.id in set(selected):
            assert m.status == "selected"
        else:
            assert m.status == "candidate"

    assert queue.render == [str(album.id)]


def test_auto_confirm_fewer_than_5(db):
    """候補が5枚未満なら在る分だけ確定する。"""
    call, album, mems = _setup(db, n_photos=3, scores=[0.3, 0.1, 0.2])
    queue = _FakeQueue()
    ok = auto_confirm.run(db, str(album.id), queue)
    assert ok is True
    db.refresh(album)
    assert len(album.selected_memory_ids) == 3
    assert album.status == "generating"


def test_auto_confirm_skip_when_not_awaiting(db):
    """status が awaiting_selection 以外なら skip（家族が選択済み）。"""
    call, album, mems = _setup(db, n_photos=6)
    album.status = "generating"  # 家族が既に確定済みを想定
    db.commit()

    queue = _FakeQueue()
    ok = auto_confirm.run(db, str(album.id), queue)
    assert ok is False
    assert queue.render == []
