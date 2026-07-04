"""backend 資産をワーカーから再利用するためのブートストラップ。

ワーカーは backend の SQLAlchemy モデル・設定・サービスを再利用する。
このモジュールを最初に import することで、リポジトリの ``backend/`` を
``sys.path`` に追加し、``from app.db import models`` などが解決できるようにする。

実行は backend/.venv の python を使う前提（依存が導入済みのため）。
詳細は docs/dev-setup.md「worker の起動」を参照。
"""

from __future__ import annotations

import sys
from pathlib import Path

# このファイルは worker/bootstrap.py。リポジトリ直下 = parents[1]。
_REPO_ROOT = Path(__file__).resolve().parents[1]
_BACKEND_ROOT = _REPO_ROOT / "backend"

# backend/ を import パスへ追加する（app.* を解決可能にする）。
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))


def repo_root() -> Path:
    """リポジトリ直下の絶対パスを返す。"""
    return _REPO_ROOT


def backend_root() -> Path:
    """backend/ の絶対パスを返す。"""
    return _BACKEND_ROOT
