"""デバイス選択の共通優先順位。

発信時の自動解決（POST /calls）と設定モーダル用の一覧取得（GET /devices）で、
「どのデバイスを先頭（＝代表）とみなすか」の規則を1箇所に集約する。両者で並びを
揃えることで、名前を付けた端末と実際に通話する端末がズレる問題（複数端末時）を防ぐ。
"""

from __future__ import annotations

from sqlalchemy import case

from app.db.models import Device


def device_priority_order() -> tuple:
    """デバイスの代表選択に使う共通の ORDER BY 式（発信解決と GET /devices で共有）。

    - active を最優先（0）、それ以外（pending / revoked）を後ろ（1）に置く。
    - 同順位内は registered_at 降順（NULL は最後＝未登録は後ろ）→ created_at 昇順で安定化する。

    発信の自動解決は status=active に絞ったうえでこの並びの先頭を採るため、
    GET /devices の先頭（active があればその中で registered_at 最新）と一致する。
    """
    active_first = case((Device.status == "active", 0), else_=1)
    return (active_first, Device.registered_at.desc().nulls_last(), Device.created_at)
