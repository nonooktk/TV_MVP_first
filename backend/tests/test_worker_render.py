"""ワーカー第2段（render）のユニットテスト。

- skip 条件（generating 以外は処理しない）
- 選択5枚を順序どおりダウンロードし動画を生成・アップロード・ready 更新
- タイトル・キャプションのフォールバック（既定値／ユーザー指定は上書きしない）
- 未選択候補への delete_after タグ付与

Blob と FFmpeg はモックする。
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[2] / "worker"
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from app.db.models import Album, Call, Device, Family, Memory, User  # noqa: E402
from stages import ffmpeg_render, stage2_video  # noqa: E402
from stages.ffmpeg_render import _xfade_offsets  # noqa: E402


class _FakeBlob:
    """download はダミー bytes、upload/タグ付与は記録するだけ。"""

    def __init__(self, *, tags_supported: bool = True) -> None:
        self.uploaded: dict[str, bytes] = {}
        self.tagged: list[tuple[str, str]] = []
        self.tags_supported = tags_supported

    def download(self, storage_key: str) -> bytes:
        return b"\xff\xd8\xff\xe0dummy-jpeg"

    def upload(self, storage_key: str, data: bytes, content_type=None) -> None:
        self.uploaded[storage_key] = data

    def set_delete_after_tag(self, storage_key: str, delete_after: str) -> bool:
        if not self.tags_supported:
            return False
        self.tagged.append((storage_key, delete_after))
        return True


def _fake_render_factory(recorder: dict):
    """ffmpeg_render.render を差し替えるフェイク。呼び出し引数を記録し空ファイルを作る。"""

    def _fake(photos, bgm, output, workdir):
        recorder["photos"] = list(photos)
        recorder["bgm"] = bgm
        output.write_bytes(b"MP4DATA")
        return "xfade"

    return _fake


def _setup(db, *, n_selected=5, n_extra=3, title=None, caption=None):
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
        started_at=datetime(2026, 7, 3, 9, 0, tzinfo=timezone.utc),
    )
    db.add(call)
    db.flush()

    selected: list[Memory] = []
    for _ in range(n_selected):
        m = Memory(
            call_id=call.id,
            type="photo",
            storage_key=f"families/{call.family_id}/calls/{call.id}/candidates/{uuid4()}.jpg",
            status="selected",
            captured_at=datetime.now(timezone.utc),
            meta_={},
        )
        db.add(m)
        selected.append(m)
    # 未選択候補（delete_after 対象）。
    extras: list[Memory] = []
    for _ in range(n_extra):
        m = Memory(
            call_id=call.id,
            type="photo",
            storage_key=f"families/{call.family_id}/calls/{call.id}/candidates/{uuid4()}.jpg",
            status="candidate",
            captured_at=datetime.now(timezone.utc),
            meta_={},
        )
        db.add(m)
        extras.append(m)
    db.flush()

    album = Album(
        call_id=call.id,
        status="generating",
        selected_memory_ids=[str(m.id) for m in selected],
        title=title,
        caption=caption,
        version=0,
        confirmed_at=datetime.now(timezone.utc),
    )
    db.add(album)
    db.commit()
    return call, album, selected, extras


def test_render_skip_when_not_generating(db):
    """status が generating 以外なら skip。"""
    call, album, selected, extras = _setup(db)
    album.status = "ready"
    db.commit()
    blob = _FakeBlob()
    ok = stage2_video.run(db, str(album.id), blob, bgm_dir=Path("/nonexistent"))
    assert ok is False
    assert blob.uploaded == {}


def test_render_happy_path(db, monkeypatch):
    """5枚を順序どおり処理し、動画アップロード・ready 更新・ラベル付与する。"""
    call, album, selected, extras = _setup(db)
    recorder: dict = {}
    monkeypatch.setattr(ffmpeg_render, "render", _fake_render_factory(recorder))

    blob = _FakeBlob()
    ok = stage2_video.run(db, str(album.id), blob, bgm_dir=Path("/nonexistent"))
    assert ok is True

    db.refresh(album)
    assert album.status == "ready"
    assert album.version == 1
    expected_key = (
        f"families/{call.family_id}/calls/{call.id}/albums/v1.mp4"
    )
    assert album.video_storage_key == expected_key
    assert expected_key in blob.uploaded

    # BGM 無し → bgm_track は None、render へ渡る bgm も None（無音）。
    assert album.bgm_track is None
    assert recorder["bgm"] is None

    # フォールバックのラベル（call.started_at=2026-07-03）。
    assert album.title == "2026年7月3日の思い出"
    assert album.caption == "5枚のベストショット"

    # 順序保持: selected_memory_ids の順で photo1..5。
    assert len(recorder["photos"]) == 5

    # 未選択3枚に delete_after タグが付与される（candidates + snippets）。
    tagged_keys = {k for k, _ in blob.tagged}
    for m in extras:
        assert m.storage_key in tagged_keys


def test_render_preserves_selected_order(db, monkeypatch):
    """selected_memory_ids の並び順どおりにダウンロード・配置される。"""
    call, album, selected, extras = _setup(db)
    # 逆順に並べ替えて確定順を作る。
    reversed_ids = [str(m.id) for m in reversed(selected)]
    album.selected_memory_ids = reversed_ids
    db.commit()

    order_log: list[str] = []

    class OrderBlob(_FakeBlob):
        def download(self, storage_key: str) -> bytes:
            order_log.append(storage_key)
            return super().download(storage_key)

    monkeypatch.setattr(ffmpeg_render, "render", _fake_render_factory({}))
    stage2_video.run(db, str(album.id), OrderBlob(), bgm_dir=Path("/nonexistent"))

    expected_order = [
        next(m.storage_key for m in selected if str(m.id) == mid)
        for mid in reversed_ids
    ]
    assert order_log == expected_order


def test_render_does_not_overwrite_user_title(db, monkeypatch):
    """ユーザー指定の title/caption があれば上書きしない。"""
    call, album, selected, extras = _setup(
        db, title="家族旅行", caption="最高の一日"
    )
    monkeypatch.setattr(ffmpeg_render, "render", _fake_render_factory({}))
    stage2_video.run(db, str(album.id), _FakeBlob(), bgm_dir=Path("/nonexistent"))
    db.refresh(album)
    assert album.title == "家族旅行"
    assert album.caption == "最高の一日"


def test_render_delete_after_tag_skipped_when_unsupported(db, monkeypatch):
    """Azurite がタグ非対応でも例外にせず処理を完了する。"""
    call, album, selected, extras = _setup(db)
    monkeypatch.setattr(ffmpeg_render, "render", _fake_render_factory({}))
    blob = _FakeBlob(tags_supported=False)
    ok = stage2_video.run(db, str(album.id), blob, bgm_dir=Path("/nonexistent"))
    assert ok is True
    db.refresh(album)
    assert album.status == "ready"


def test_xfade_offsets_recomputed_for_fewer_photos():
    """5枚未満で offset が再計算される（4枚: 6,12,18／3枚: 6,12）。"""
    assert _xfade_offsets(5) == [6, 12, 18, 24]
    assert _xfade_offsets(4) == [6, 12, 18]
    assert _xfade_offsets(3) == [6, 12]
    assert _xfade_offsets(2) == [6]
    assert _xfade_offsets(1) == []
