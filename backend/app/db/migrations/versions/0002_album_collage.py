"""albums に collage_storage_key を追加（手書き）。

確定5枚から生成する1枚のコラージュ画像の Blob 参照列を albums に追加する。
nullable（未生成・生成失敗時は null）。既存行への影響なし。

Revision ID: 0002_album_collage
Revises: 0001_initial
Create Date: 2026-07-05

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002_album_collage"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "albums",
        sa.Column("collage_storage_key", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("albums", "collage_storage_key")
