"""ワーカーのメッセージ分岐・デコード・毒メッセージ処理のユニットテスト。

キュー/Blob は使わず、フェイクで検証する。
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

_WORKER_ROOT = Path(__file__).resolve().parents[2] / "worker"
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

import main as worker_main  # noqa: E402
from services import decode_message  # noqa: E402


def _encode(msg: dict) -> str:
    return base64.b64encode(json.dumps(msg).encode("utf-8")).decode("ascii")


def test_decode_message_roundtrip():
    msg = {"schema_version": 1, "job_type": "score", "call_id": "x"}
    assert decode_message(_encode(msg)) == msg


def test_process_message_dispatches_by_job_type(monkeypatch):
    """job_type ごとに正しいステージ関数へ委譲する。"""
    calls: list[str] = []

    monkeypatch.setattr(
        worker_main.stage1_scoring, "run",
        lambda db, call_id, queue, blob: calls.append(f"score:{call_id}"),
    )
    monkeypatch.setattr(
        worker_main.auto_confirm, "run",
        lambda db, album_id, queue: calls.append(f"auto:{album_id}"),
    )
    monkeypatch.setattr(
        worker_main.stage2_video, "run",
        lambda db, album_id, blob: calls.append(f"render:{album_id}"),
    )

    class _DB:
        def close(self):
            pass

    def db_factory():
        return _DB()

    for job in (
        {"schema_version": 1, "job_type": "score", "call_id": "c1"},
        {"schema_version": 1, "job_type": "auto_confirm", "album_id": "a1"},
        {"schema_version": 1, "job_type": "render", "album_id": "a2"},
        {"schema_version": 1, "job_type": "unknown"},  # 無視される
    ):
        msg = SimpleNamespace(content=_encode(job), id="m", dequeue_count=1)
        worker_main.process_message(msg, db_factory=db_factory, blob=None, queue=None)

    assert calls == ["score:c1", "auto:a1", "render:a2"]


def test_handle_poison_quarantines_to_blob():
    """毒メッセージが system/poison/{id}.json へ退避される。"""
    uploaded: dict[str, bytes] = {}

    class _Blob:
        def upload(self, key, data, content_type=None):
            uploaded[key] = data

    mid = str(uuid4())
    msg = SimpleNamespace(id=mid, dequeue_count=6, content=_encode({"job_type": "score"}))
    worker_main._handle_poison(_Blob(), msg)

    key = f"system/poison/{mid}.json"
    assert key in uploaded
    payload = json.loads(uploaded[key].decode("utf-8"))
    assert payload["message_id"] == mid
    assert payload["dequeue_count"] == 6
    assert "quarantined_at" in payload
    assert payload["content"] == msg.content


def test_poison_threshold_constant():
    """毒メッセージ閾値は dequeue_count > 5。"""
    assert worker_main.POISON_DEQUEUE_THRESHOLD == 5
