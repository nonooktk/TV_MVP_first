"""初回マイグレーション（手書き）。

models.py と完全一致するスキーマを作成する。
ENUM型（PostgreSQLネイティブ）の create/drop も明示的に管理する。

Revision ID: 0001_initial
Revises:
Create Date: 2026-07-02

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# --- ENUM 型定義 ---------------------------------------------------------------
# create_type=False とし、テーブル作成前に明示的に CREATE TYPE する。
# （テーブル定義内でColumn型として渡すと重複作成を試みるため。）

user_role = postgresql.ENUM(
    "owner", "viewer", name="user_role", create_type=False
)
device_status = postgresql.ENUM(
    "pending", "active", "revoked", name="device_status", create_type=False
)
call_status = postgresql.ENUM(
    "calling", "active", "ended", name="call_status", create_type=False
)
memory_type = postgresql.ENUM(
    "photo", "audio", name="memory_type", create_type=False
)
memory_status = postgresql.ENUM(
    "candidate", "selected", name="memory_status", create_type=False
)
album_status = postgresql.ENUM(
    "awaiting_selection", "generating", "ready", name="album_status", create_type=False
)

_ALL_ENUMS = (
    user_role,
    device_status,
    call_status,
    memory_type,
    memory_status,
    album_status,
)


def upgrade() -> None:
    bind = op.get_bind()

    # 1) ENUM 型を作成する
    for enum in _ALL_ENUMS:
        enum.create(bind, checkfirst=True)

    # 2) families
    op.create_table(
        "families",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # 3) users
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("family_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", user_role, nullable=False),
        sa.Column("auth_id", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("auth_id"),
    )
    op.create_index("ix_users_family_id", "users", ["family_id"])

    # 4) devices
    op.create_table(
        "devices",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("family_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "fixed_contact_user_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column(
            "status",
            device_status,
            server_default=sa.text("'pending'"),
            nullable=False,
        ),
        sa.Column("registration_token_hash", sa.String(), nullable=True),
        sa.Column(
            "registration_expires_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column("registered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("device_token_hash", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"]),
        sa.ForeignKeyConstraint(["fixed_contact_user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_devices_family_id", "devices", ["family_id"])

    # 5) calls
    op.create_table(
        "calls",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("family_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("device_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("caller_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("channel_name", sa.String(), nullable=False),
        sa.Column(
            "status",
            call_status,
            server_default=sa.text("'calling'"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"]),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"]),
        sa.ForeignKeyConstraint(["caller_user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    # calls(family_id, started_at) 複合インデックス
    op.create_index(
        "ix_calls_family_id_started_at", "calls", ["family_id", "started_at"]
    )

    # 6) memories
    op.create_table(
        "memories",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("call_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("type", memory_type, nullable=False),
        sa.Column("storage_key", sa.String(), nullable=False),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column(
            "status",
            memory_status,
            server_default=sa.text("'candidate'"),
            nullable=False,
        ),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["call_id"], ["calls.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    # memories(call_id) と memories(call_id, score)
    op.create_index("ix_memories_call_id", "memories", ["call_id"])
    op.create_index("ix_memories_call_id_score", "memories", ["call_id", "score"])

    # 7) albums
    op.create_table(
        "albums",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("call_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "status",
            album_status,
            server_default=sa.text("'awaiting_selection'"),
            nullable=False,
        ),
        sa.Column(
            "selected_memory_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("caption", sa.String(), nullable=True),
        sa.Column("bgm_track", sa.String(), nullable=True),
        sa.Column("video_storage_key", sa.String(), nullable=True),
        sa.Column(
            "version", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("presented_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "auto_confirmed",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["call_id"], ["calls.id"]),
        sa.PrimaryKeyConstraint("id"),
        # 1通話に0..1アルバム
        sa.UniqueConstraint("call_id"),
    )
    op.create_index("ix_albums_status", "albums", ["status"])


def downgrade() -> None:
    bind = op.get_bind()

    # テーブルを依存の逆順で削除する
    op.drop_index("ix_albums_status", table_name="albums")
    op.drop_table("albums")

    op.drop_index("ix_memories_call_id_score", table_name="memories")
    op.drop_index("ix_memories_call_id", table_name="memories")
    op.drop_table("memories")

    op.drop_index("ix_calls_family_id_started_at", table_name="calls")
    op.drop_table("calls")

    op.drop_index("ix_devices_family_id", table_name="devices")
    op.drop_table("devices")

    op.drop_index("ix_users_family_id", table_name="users")
    op.drop_table("users")

    op.drop_table("families")

    # ENUM 型を削除する
    for enum in reversed(_ALL_ENUMS):
        enum.drop(bind, checkfirst=True)
