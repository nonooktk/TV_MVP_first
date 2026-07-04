"""Azure Storage Queue サービス（パイプライン投函）。

メッセージ形式・投函ルールは docs/data-contract.md §3 が正。
- キュー名: pipeline-jobs（1本）
- エンコード: Base64（デコード後は UTF-8 JSON）
- 共通フィールド: schema_version(=1) / job_type / requested_at(ISO8601 UTC)

FastAPI が投函するのは score（media/register 時）と render（selection 確定時）の2種。
auto_confirm は候補提示時にワーカー第1段が可視化遅延300秒で投函するため、ここでは扱わない。

テスト時は DI で差し替え可能（app.api.deps.get_queue_service を FakeQueueService へ override）。
"""

from __future__ import annotations

import base64
import json
from datetime import datetime, timezone

from azure.storage.queue import QueueClient

SCHEMA_VERSION = 1


def _now_iso() -> str:
    """投函時刻を ISO 8601 UTC で返す。"""
    return datetime.now(timezone.utc).isoformat()


def _encode(message: dict) -> str:
    """メッセージ dict を UTF-8 JSON→Base64 文字列にする。"""
    raw = json.dumps(message, ensure_ascii=False).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


class QueueService:
    """pipeline-jobs キューへの投函を担当する。"""

    def __init__(self, connection_string: str, queue_name: str) -> None:
        self.queue_name = queue_name
        self._client = QueueClient.from_connection_string(
            connection_string, queue_name
        )

    def ensure_queue(self) -> None:
        """キューが無ければ作成する。冪等。"""
        try:
            self._client.create_queue()
        except Exception:
            pass

    def enqueue_score(self, call_id: str) -> None:
        """score ジョブ（第1段スコアリング）を投函する。media/register 完了時。"""
        self._send(
            {
                "schema_version": SCHEMA_VERSION,
                "job_type": "score",
                "call_id": str(call_id),
                "requested_at": _now_iso(),
            }
        )

    def enqueue_render(self, album_id: str) -> None:
        """render ジョブ（第2段動画生成）を投函する。selection 確定時。"""
        self._send(
            {
                "schema_version": SCHEMA_VERSION,
                "job_type": "render",
                "album_id": str(album_id),
                "requested_at": _now_iso(),
            }
        )

    def _send(self, message: dict) -> None:
        self._client.send_message(_encode(message))


class FakeQueueService:
    """テスト用のフェイク実装。投函内容を messages に記録するだけ。"""

    def __init__(self) -> None:
        self.messages: list[dict] = []

    def ensure_queue(self) -> None:  # noqa: D102
        pass

    def enqueue_score(self, call_id: str) -> None:  # noqa: D102
        self.messages.append(
            {
                "schema_version": SCHEMA_VERSION,
                "job_type": "score",
                "call_id": str(call_id),
                "requested_at": _now_iso(),
            }
        )

    def enqueue_render(self, album_id: str) -> None:  # noqa: D102
        self.messages.append(
            {
                "schema_version": SCHEMA_VERSION,
                "job_type": "render",
                "album_id": str(album_id),
                "requested_at": _now_iso(),
            }
        )
