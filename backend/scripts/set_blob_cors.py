"""Blob サービス（Azurite）に CORS を設定する開発用スクリプト（冪等）。

コア②（frontend/src/modules/sync）はブラウザから SAS URL へ直接 Blob を PUT する。
これはストレージアカウント側の CORS 設定を必要とする。
- 本番（Azure）: A1（Azure構築）の担当。ストレージアカウントに CORS ルールを設定する。
- ローカル（Azurite）: 本スクリプトで設定する（Azurite はデフォルト CORS 無効）。

許可オリジンは既定で http://localhost:3000（frontend の dev サーバ）。
`--origins` で追加指定できる。

実行:
    cd backend
    .venv/bin/python scripts/set_blob_cors.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# backend/ を import パスに追加する（このファイルは backend/scripts/set_blob_cors.py）。
_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.core.config import get_settings  # noqa: E402
from app.services.blob import BlobService  # noqa: E402

DEFAULT_ORIGINS = ["http://localhost:3000"]


def main() -> None:
    parser = argparse.ArgumentParser(description="Blob サービスに CORS を設定する")
    parser.add_argument(
        "--origins",
        nargs="*",
        default=DEFAULT_ORIGINS,
        help="許可するオリジン（既定: http://localhost:3000）",
    )
    args = parser.parse_args()

    settings = get_settings()
    blob = BlobService(
        settings.AZURE_STORAGE_CONNECTION_STRING, settings.MEDIA_CONTAINER
    )
    blob.ensure_container()
    blob.set_cors(args.origins)
    print("=== Blob CORS 設定完了 ===")
    print(f"container       : {blob.container}")
    print(f"allowed_origins : {args.origins}")


if __name__ == "__main__":
    main()
