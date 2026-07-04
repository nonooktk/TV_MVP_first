"""認証・トークンハッシュのユーティリティ。

トークン類（登録トークン・デバイストークン）は平文でDBに持たず、sha256 ハッシュのみを
保存する。照合時は入力を同じ方式でハッシュして比較する。
"""

from __future__ import annotations

import hashlib


def sha256_hex(token: str) -> str:
    """トークン文字列を sha256 で16進ハッシュ化する。

    登録トークン・デバイストークンの保存／照合の両方でこの関数を使う。
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
