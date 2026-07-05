"""ワーカーのエントリポイント（キューポーリングループ）。

Azure Storage Queue（pipeline-jobs）をポーリングし、job_type に応じて分岐する。
メッセージ形式・投函ルール・冪等性・可視性タイムアウト・毒メッセージ処理は
docs/data-contract.md §3 に準拠する。

実行（backend/.venv の python を使う。詳細は docs/dev-setup.md「worker の起動」）:

    cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP
    backend/.venv/bin/python worker/main.py            # 常駐ポーリング
    backend/.venv/bin/python worker/main.py --once     # キューが空になるまで処理して終了
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# --- import パス整備（backend/ と worker/ を通す）-------------------------------
# このファイルは worker/main.py。
_WORKER_ROOT = Path(__file__).resolve().parent
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

import bootstrap  # noqa: E402  backend/ を sys.path に追加する

# backend/.env を os.environ へ読み込む（ファイルが無ければ何もしない）。
# pydantic-settings は .env を Settings オブジェクトにしか反映しないため、
# os.environ を直接参照する設定（stages/labels.py の LABEL_PROVIDER /
# OPENAI_API_KEY / AZURE_OPENAI_* など）はここで取り込む。
# override=False: 既存の実環境変数が優先（クラウド=Container Apps の挙動は不変）。
from dotenv import load_dotenv  # noqa: E402  pydantic-settings の依存として導入済み

load_dotenv(bootstrap.backend_root() / ".env", override=False)

from app.core.config import get_settings  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402

from services import (  # noqa: E402
    WorkerBlobService,
    WorkerQueueService,
    decode_message,
)
from stages import auto_confirm, stage1_scoring, stage2_video  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
# Azure SDK（Storage Queue/Blob）の HTTP ログは冗長でクラウドのログを埋め尽くすため
# WARNING 以上に抑制する（業務ログ＝worker.* を読めるようにする）。
logging.getLogger("azure").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logger = logging.getLogger("worker.main")

# 毒メッセージ判定閾値（dequeue_count がこれを超えたら退避。data-contract.md §3）。
POISON_DEQUEUE_THRESHOLD = 5
# 空ポーリング時の待機秒。
EMPTY_POLL_SLEEP = 2


def _handle_poison(blob: WorkerBlobService, message) -> None:
    """毒メッセージを media コンテナの system/poison/ へ退避する。"""
    payload = {
        "message_id": message.id,
        "dequeue_count": message.dequeue_count,
        "content": message.content,
        "quarantined_at": datetime.now(timezone.utc).isoformat(),
    }
    key = f"system/poison/{message.id}.json"
    try:
        blob.upload(
            key,
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            content_type="application/json",
        )
        logger.warning(
            "毒メッセージを退避: id=%s dequeue_count=%s → %s",
            message.id,
            message.dequeue_count,
            key,
        )
    except Exception as e:  # noqa: BLE001
        logger.error("毒メッセージ退避に失敗: id=%s err=%s", message.id, e)


def process_message(message, *, db_factory, blob, queue) -> None:
    """1メッセージを処理する（job_type 分岐）。呼び出し側で削除する。"""
    body = decode_message(message.content)
    job_type = body.get("job_type")
    db = db_factory()
    try:
        if job_type == "score":
            stage1_scoring.run(db, body["call_id"], queue, blob)
        elif job_type == "auto_confirm":
            auto_confirm.run(db, body["album_id"], queue)
        elif job_type == "render":
            stage2_video.run(db, body["album_id"], blob)
        else:
            logger.warning("未知の job_type: %r（無視して削除する）", job_type)
    finally:
        db.close()


def _poll_loop(*, once: bool) -> None:
    """ポーリングループ本体。"""
    settings = get_settings()
    blob = WorkerBlobService(
        settings.AZURE_STORAGE_CONNECTION_STRING, settings.MEDIA_CONTAINER
    )
    queue = WorkerQueueService(
        settings.AZURE_STORAGE_CONNECTION_STRING, settings.QUEUE_NAME
    )
    blob.ensure_container()
    queue.ensure_queue()

    logger.info("worker 起動: once=%s queue=%s", once, settings.QUEUE_NAME)

    while True:
        message = queue.receive_one()
        if message is None:
            if once:
                logger.info("キューが空。--once のため終了する。")
                return
            time.sleep(EMPTY_POLL_SLEEP)
            continue

        # 毒メッセージ判定（処理せず退避して削除）。
        if (message.dequeue_count or 0) > POISON_DEQUEUE_THRESHOLD:
            _handle_poison(blob, message)
            queue.delete(message)
            continue

        try:
            process_message(
                message, db_factory=SessionLocal, blob=blob, queue=queue
            )
            queue.delete(message)
        except Exception:  # noqa: BLE001
            # 処理失敗時は削除しない → 可視性タイムアウト後に再配達され、
            # dequeue_count が閾値を超えたら毒メッセージとして退避される。
            logger.exception("メッセージ処理に失敗（再配達に委ねる）: id=%s", message.id)


def main() -> None:
    parser = argparse.ArgumentParser(description="通話後パイプライン ワーカー")
    parser.add_argument(
        "--once",
        action="store_true",
        help="キューが空になるまで処理して終了する（テスト・デモ用）",
    )
    args = parser.parse_args()
    _poll_loop(once=args.once)


if __name__ == "__main__":
    main()
