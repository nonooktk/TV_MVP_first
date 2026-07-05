"""SQLAlchemyモデル定義（SQLAlchemy 2.0スタイル）。

台帳（PostgreSQL）のスキーマ本体。メディア実体はBlobに置き、DBは参照キーのみを持つ。
カラム定義の正本は docs/db-schema.md（クラス図準拠）。共通契約は A4（openapi.yaml）と一致させる。

規約:
- 全テーブルの主キーは UUID v4（`id`）、`created_at` は timestamptz の server_default now()。
- ENUM は PostgreSQL ネイティブ ENUM（名前付き）を使う。
- JSONB は postgresql.JSONB を使う。
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    text,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """全モデルの基底クラス。Alembic の target_metadata に使う。"""

    pass


# --- 共通ヘルパ -----------------------------------------------------------------

def _uuid_pk() -> Mapped[uuid.UUID]:
    """UUID v4 主キー列を生成する。"""
    return mapped_column(
        postgresql.UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )


def _created_at() -> Mapped[datetime]:
    """created_at 列（timestamptz・server_default now()）を生成する。"""
    return mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )


# --- ENUM 定義（PostgreSQL ネイティブ・名前付き） -------------------------------
# create_type=False とし、型の作成/削除はマイグレーション（0001_initial）で明示的に管理する。

user_role_enum = Enum(
    "owner", "viewer", name="user_role", create_type=False
)
device_status_enum = Enum(
    "pending", "active", "revoked", name="device_status", create_type=False
)
call_status_enum = Enum(
    "calling", "active", "ended", name="call_status", create_type=False
)
memory_type_enum = Enum(
    "photo", "audio", name="memory_type", create_type=False
)
memory_status_enum = Enum(
    "candidate", "selected", name="memory_status", create_type=False
)
album_status_enum = Enum(
    "awaiting_selection", "generating", "ready", name="album_status", create_type=False
)


# --- テーブル定義 ---------------------------------------------------------------


class Family(Base):
    """家族グループ。ユーザー・デバイス・通話の帰属単位。"""

    __tablename__ = "families"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = _created_at()

    # リレーション
    users: Mapped[list[User]] = relationship(back_populates="family")
    devices: Mapped[list[Device]] = relationship(back_populates="family")
    calls: Mapped[list[Call]] = relationship(back_populates="family")


class User(Base):
    """利用者（家族側）。owner が家族の管理者、viewer は閲覧のみ。"""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    family_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        ForeignKey("families.id"),
        nullable=False,
        index=True,  # users.family_id インデックス
    )
    role: Mapped[str] = mapped_column(user_role_enum, nullable=False)
    # Entra ID の subject。招待前は未確定のため nullable。値がある場合は一意。
    auth_id: Mapped[str | None] = mapped_column(String, nullable=True, unique=True)
    created_at: Mapped[datetime] = _created_at()

    # リレーション
    family: Mapped[Family] = relationship(back_populates="users")
    # このユーザーが固定通話相手になっているデバイス群
    fixed_devices: Mapped[list[Device]] = relationship(
        back_populates="fixed_contact_user"
    )


class Device(Base):
    """高齢者側デバイス（待受端末）。

    初回のみワンタイム登録リンクで登録し、以降は待受認証用の X-Device-Token で
    ポーリングする。トークンは平文で持たずハッシュのみを保持する。
    """

    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = _uuid_pk()
    family_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        ForeignKey("families.id"),
        nullable=False,
        index=True,  # devices.family_id インデックス
    )
    # 固定通話相手（家族側ユーザー）
    fixed_contact_user_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        device_status_enum, nullable=False, server_default=text("'pending'")
    )
    # 初回登録リンクのトークンハッシュ（登録完了後はnullでよい）
    registration_token_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    # 登録リンクの有効期限
    registration_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 登録完了時刻
    registered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 待受認証用 X-Device-Token のハッシュ
    device_token_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = _created_at()

    # リレーション
    family: Mapped[Family] = relationship(back_populates="devices")
    fixed_contact_user: Mapped[User] = relationship(back_populates="fixed_devices")
    calls: Mapped[list[Call]] = relationship(back_populates="device")


class Call(Base):
    """通話記録。channel_name は通話ごとにローテーションする。"""

    __tablename__ = "calls"
    __table_args__ = (
        # 家族の通話履歴を時系列で引くための複合インデックス
        Index("ix_calls_family_id_started_at", "family_id", "started_at"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    family_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        ForeignKey("families.id"),
        nullable=False,
    )
    device_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        ForeignKey("devices.id"),
        nullable=False,
    )
    # 発信した家族側ユーザー。高齢者側発信や不明の場合があるため nullable。
    caller_user_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=True,
    )
    channel_name: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(
        call_status_enum, nullable=False, server_default=text("'calling'")
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = _created_at()

    # リレーション
    family: Mapped[Family] = relationship(back_populates="calls")
    device: Mapped[Device] = relationship(back_populates="calls")
    caller_user: Mapped[User | None] = relationship()
    memories: Mapped[list[Memory]] = relationship(back_populates="call")
    # 1通話に0..1アルバム
    album: Mapped[Album | None] = relationship(back_populates="call", uselist=False)


class Memory(Base):
    """通話中に検知された候補メディア（写真1枚 or 音声スニペット）。"""

    __tablename__ = "memories"
    __table_args__ = (
        # 通話単位の候補取得用
        Index("ix_memories_call_id", "call_id"),
        # 第1段ランキング（通話内スコア順）用
        Index("ix_memories_call_id_score", "call_id", "score"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    call_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        ForeignKey("calls.id"),
        nullable=False,
    )
    type: Mapped[str] = mapped_column(memory_type_enum, nullable=False)
    storage_key: Mapped[str] = mapped_column(String, nullable=False)  # Blob参照
    # 第1段スコアリングの結果。取り込み直後は未算出のため nullable。
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(
        memory_status_enum, nullable=False, server_default=text("'candidate'")
    )
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    # 検知メタデータ（音圧・VAD・MediaPipe指標・STTラベル等）。
    # DB列名は "metadata"。SQLAlchemy Declarative の予約属性名 `metadata` を避けるため
    # 属性名は meta_ とし、name= でDB列名を固定する。
    meta_: Mapped[dict] = mapped_column(
        "metadata",
        postgresql.JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    created_at: Mapped[datetime] = _created_at()

    # リレーション
    call: Mapped[Call] = relationship(back_populates="memories")


class Album(Base):
    """完成したハイライトアルバム。1通話に0..1（call_id は unique）。

    確定5枚は selected_memory_ids に順序保持で持つ。差し替えのたびに動画を
    再レンダリングし version を +1 する。提示から5分無選択で上位5枚に自動確定する。
    """

    __tablename__ = "albums"
    __table_args__ = (
        # ready の最新取得・状態別の抽出用
        Index("ix_albums_status", "status"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    # 1通話に0..1のため unique
    call_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        ForeignKey("calls.id"),
        nullable=False,
        unique=True,
    )
    status: Mapped[str] = mapped_column(
        album_status_enum,
        nullable=False,
        server_default=text("'awaiting_selection'"),
    )
    # 確定5枚の memory id 配列（順序保持）。確定前は null 可。
    selected_memory_ids: Mapped[list | None] = mapped_column(
        postgresql.JSONB, nullable=True
    )
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    caption: Mapped[str | None] = mapped_column(String, nullable=True)
    bgm_track: Mapped[str | None] = mapped_column(String, nullable=True)
    video_storage_key: Mapped[str | None] = mapped_column(String, nullable=True)
    # 確定5枚から生成する1枚のコラージュ画像の Blob 参照（第2段 render で生成）。
    # 未生成・生成失敗時は null（動画は成立させる）。
    collage_storage_key: Mapped[str | None] = mapped_column(String, nullable=True)
    # 第2段レンダリングごとに +1
    version: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    # 候補提示時刻（5分自動確定の基準）
    presented_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 自動確定されたか（5分無選択で True）
    auto_confirmed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = _created_at()

    # リレーション
    call: Mapped[Call] = relationship(back_populates="album")
