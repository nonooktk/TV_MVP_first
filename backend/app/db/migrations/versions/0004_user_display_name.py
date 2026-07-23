"""users に display_name を追加（手書き）。

家族メンバー自身が設定する表示名を保持する列を users に追加する。
TV側の着信・通話ラベル（caller_display_name）や家族通話画面の自分小窓ラベルに使う。
nullable（未設定は null＝フロントはフォールバック）。既存行への影響なし。
0003_device_display_name と同型の nullable 列1本追加。

注意（downgrade の非可逆性）: downgrade は `users.display_name` 列を drop するため、
**利用者が入力済みの表示名データを不可逆に削除する**（列ごと消える＝復元不可）。
ロールバック時は事前に値の退避が必要かを必ず確認すること。

Revision ID: 0004_user_display_name
Revises: 0003_device_display_name
Create Date: 2026-07-23

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004_user_display_name"
down_revision: Union[str, None] = "0003_device_display_name"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("display_name", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "display_name")
