"""devices に display_name を追加（手書き）。

家族（owner）が高齢者側デバイスに付ける表示名を保持する列を devices に追加する。
通話画面の Zoom 風ラベル（相手の名前）に使う。nullable（未設定は null＝ラベル非表示）。
既存行への影響なし。0002_album_collage と同型の nullable 列1本追加。

注意（downgrade の非可逆性）: downgrade は `devices.display_name` 列を drop するため、
**利用者が入力済みの表示名データを不可逆に削除する**（列ごと消える＝復元不可）。
ロールバック時は事前に値の退避が必要かを必ず確認すること。

Revision ID: 0003_device_display_name
Revises: 0002_album_collage
Create Date: 2026-07-23

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003_device_display_name"
down_revision: Union[str, None] = "0002_album_collage"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "devices",
        sa.Column("display_name", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("devices", "display_name")
