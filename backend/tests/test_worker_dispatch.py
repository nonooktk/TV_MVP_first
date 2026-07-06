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


# --- ポーリングループの削除セマンティクス（不具合1 の再発防止） -----------------
#
# 不具合1（実通話のアルバムが作られない）の調査で、ジョブが「消費されたのに成果物なし・
# 毒ゼロ」なら例外の握りつぶし（失敗時にメッセージを delete している）が最有力仮説だった。
# 実際には別原因（ユーザーが手動 DELETE）だったが、契約どおりの挙動＝
# 「成功時のみ delete・失敗時は delete せず再配達に委ねる」を回帰テストで固定する。


class _FakeQueue:
    """receive_one を1回だけ返し、delete 呼び出しを記録するフェイクキュー。"""

    def __init__(self, messages):
        self._messages = list(messages)
        self.deleted = []

    def ensure_queue(self):
        pass

    def receive_one(self):
        if self._messages:
            return self._messages.pop(0)
        return None

    def delete(self, message):
        self.deleted.append(message.id)


class _FakeBlob:
    def __init__(self):
        self.uploaded = {}

    def ensure_container(self):
        pass

    def upload(self, key, data, content_type=None):
        self.uploaded[key] = data


def _run_once(monkeypatch, queue, blob):
    """_poll_loop(once=True) を、settings/サービス生成を差し替えて実行する。"""
    monkeypatch.setattr(
        worker_main, "get_settings",
        lambda: SimpleNamespace(
            AZURE_STORAGE_CONNECTION_STRING="x",
            MEDIA_CONTAINER="media",
            QUEUE_NAME="pipeline-jobs",
        ),
    )
    monkeypatch.setattr(worker_main, "WorkerBlobService", lambda cs, c: blob)
    monkeypatch.setattr(worker_main, "WorkerQueueService", lambda cs, q: queue)
    monkeypatch.setattr(worker_main, "SessionLocal", lambda: SimpleNamespace(close=lambda: None))
    worker_main._poll_loop(once=True)


def test_poll_loop_deletes_on_success(monkeypatch):
    """処理成功時はメッセージを削除する。"""
    msg = SimpleNamespace(
        id="ok1", dequeue_count=1,
        content=_encode({"job_type": "score", "call_id": "c1"}),
    )
    queue = _FakeQueue([msg])
    monkeypatch.setattr(worker_main, "process_message", lambda *a, **k: None)
    _run_once(monkeypatch, queue, _FakeBlob())
    assert queue.deleted == ["ok1"]


def test_poll_loop_does_not_delete_on_exception(monkeypatch):
    """処理失敗（例外）時はメッセージを削除しない（再配達に委ねる）。

    不具合1 の再発防止: 例外を握りつぶして delete すると「消費されたのに成果物なし・
    毒ゼロ」になる。失敗時に delete が呼ばれないことを固定する。
    """
    msg = SimpleNamespace(
        id="boom1", dequeue_count=1,
        content=_encode({"job_type": "score", "call_id": "c1"}),
    )
    queue = _FakeQueue([msg])

    def _raise(*a, **k):
        raise RuntimeError("stage1 crashed on bad metadata")

    monkeypatch.setattr(worker_main, "process_message", _raise)
    _run_once(monkeypatch, queue, _FakeBlob())
    # 削除されていない → 可視性タイムアウト後に再配達される。
    assert queue.deleted == []


def test_poll_loop_quarantines_and_deletes_poison(monkeypatch):
    """dequeue_count が閾値超過の毒メッセージは退避して削除する。"""
    msg = SimpleNamespace(
        id="poison1", dequeue_count=6,
        content=_encode({"job_type": "score", "call_id": "c1"}),
    )
    queue = _FakeQueue([msg])
    blob = _FakeBlob()
    # process_message は呼ばれないはず（毒判定が先）。
    monkeypatch.setattr(
        worker_main, "process_message",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("毒は処理しない")),
    )
    _run_once(monkeypatch, queue, blob)
    assert queue.deleted == ["poison1"]
    assert "system/poison/poison1.json" in blob.uploaded
