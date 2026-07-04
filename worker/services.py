"""ワーカー用の外部サービスクライアント（Blob / Queue）。

backend の設定（AZURE_STORAGE_CONNECTION_STRING 等）を再利用しつつ、ワーカーに必要な
操作（Blob のダウンロード／アップロード／タグ付与、キューの受信／削除／可視化遅延投函）を提供する。
SAS 発行は backend のみが行う契約のため、ここには含めない（docs/data-contract.md §2）。
"""

from __future__ import annotations

import base64
import json
import logging
from datetime import datetime, timezone

from azure.storage.blob import BlobServiceClient
from azure.storage.queue import QueueClient

logger = logging.getLogger("worker.services")

SCHEMA_VERSION = 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- Blob ---------------------------------------------------------------------


class WorkerBlobService:
    """ワーカー用 Blob クライアント（download / upload / tag）。"""

    def __init__(self, connection_string: str, container: str) -> None:
        self.container = container
        self._client = BlobServiceClient.from_connection_string(connection_string)

    def ensure_container(self) -> None:
        """コンテナが無ければ作成する。冪等。"""
        try:
            self._client.create_container(self.container)
        except Exception:
            pass

    def download(self, storage_key: str) -> bytes:
        """storage_key（コンテナ名を除くフルパス）の Blob を bytes で取得する。"""
        blob = self._client.get_blob_client(self.container, storage_key)
        return blob.download_blob().readall()

    def upload(self, storage_key: str, data: bytes, content_type: str | None = None) -> None:
        """Blob へアップロードする（上書き）。"""
        from azure.storage.blob import ContentSettings

        blob = self._client.get_blob_client(self.container, storage_key)
        cs = ContentSettings(content_type=content_type) if content_type else None
        blob.upload_blob(data, overwrite=True, content_settings=cs)

    def set_delete_after_tag(self, storage_key: str, delete_after: str) -> bool:
        """Blob にインデックスタグ delete_after を付与する。

        - 対象 Blob が存在しなければ何もせず False（存在しないだけなので警告不要）。
        - Azurite がタグ API 非対応の場合も警告して False（data-contract.md §2
          ライフサイクル。MVP はタグ付与を必須要件とするが、エミュレータ非対応は許容）。
        """
        from azure.core.exceptions import ResourceNotFoundError

        blob = self._client.get_blob_client(self.container, storage_key)
        try:
            blob.set_blob_tags({"delete_after": delete_after})
            return True
        except ResourceNotFoundError:
            # 対象 Blob が無い（例: スニペット未生成の候補）。想定内なので debug ログ。
            logger.debug("delete_after: 対象 Blob が存在しない key=%s", storage_key)
            return False
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "delete_after タグ付与に失敗（タグ API 非対応の可能性）: key=%s err=%s",
                storage_key,
                e,
            )
            return False


# --- Queue --------------------------------------------------------------------


class WorkerQueueService:
    """ワーカー用キュークライアント（受信・削除・投函）。

    受信は visibility_timeout=300 秒で行い、処理中の再配達を防ぐ。
    auto_confirm は可視化遅延（visibility_timeout 付き send）で投函する。
    """

    # 取り出し時の可視化タイムアウト（処理中の再配達防止。data-contract.md §3）。
    RECEIVE_VISIBILITY_TIMEOUT = 300

    def __init__(self, connection_string: str, queue_name: str) -> None:
        self.queue_name = queue_name
        self._client = QueueClient.from_connection_string(
            connection_string, queue_name
        )

    def ensure_queue(self) -> None:
        try:
            self._client.create_queue()
        except Exception:
            pass

    def receive_one(self):
        """メッセージを1件受信する（無ければ None）。"""
        it = self._client.receive_messages(
            max_messages=1,
            visibility_timeout=self.RECEIVE_VISIBILITY_TIMEOUT,
        )
        for msg in it:
            return msg
        return None

    def delete(self, message) -> None:
        """処理済みメッセージをキューから削除する。"""
        self._client.delete_message(message)

    def enqueue_render(self, album_id: str) -> None:
        self._send(
            {
                "schema_version": SCHEMA_VERSION,
                "job_type": "render",
                "album_id": str(album_id),
                "requested_at": _now_iso(),
            }
        )

    def enqueue_auto_confirm(self, album_id: str, delay_seconds: int = 300) -> None:
        """auto_confirm を可視化遅延（delay_seconds）付きで投函する。"""
        self._send(
            {
                "schema_version": SCHEMA_VERSION,
                "job_type": "auto_confirm",
                "album_id": str(album_id),
                "requested_at": _now_iso(),
            },
            visibility_timeout=delay_seconds,
        )

    def enqueue_score(self, call_id: str) -> None:
        """score を投函する（主に backend が投函するが、デモ・再投函用に用意）。"""
        self._send(
            {
                "schema_version": SCHEMA_VERSION,
                "job_type": "score",
                "call_id": str(call_id),
                "requested_at": _now_iso(),
            }
        )

    def _send(self, message: dict, visibility_timeout: int | None = None) -> None:
        raw = json.dumps(message, ensure_ascii=False).encode("utf-8")
        content = base64.b64encode(raw).decode("ascii")
        self._client.send_message(content, visibility_timeout=visibility_timeout)


def decode_message(content: str) -> dict:
    """キューメッセージ本文（Base64 → UTF-8 JSON）をデコードして dict を返す。"""
    raw = base64.b64decode(content)
    return json.loads(raw.decode("utf-8"))
