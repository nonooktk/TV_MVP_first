"""Blob パス（storage_key）生成ヘルパ。

パス規約は docs/data-contract.md §2 が正。storage_key はコンテナ名 `media` を除く
フルパス（families/… から始まる）。ID はハイフン付き小文字の UUID 表記。
"""

from __future__ import annotations

from uuid import UUID


def call_prefix(family_id: UUID, call_id: UUID) -> str:
    """当該通話のプレフィックス families/{family_id}/calls/{call_id}/ を返す。"""
    return f"families/{family_id}/calls/{call_id}/"


def candidate_key(family_id: UUID, call_id: UUID, memory_id: UUID) -> str:
    """連写候補（JPEG）の storage_key。"""
    return f"{call_prefix(family_id, call_id)}candidates/{memory_id}.jpg"


def snippet_key(family_id: UUID, call_id: UUID, memory_id: UUID) -> str:
    """音声スニペット（WebM）の storage_key。"""
    return f"{call_prefix(family_id, call_id)}snippets/{memory_id}.webm"


def thumb_key(family_id: UUID, call_id: UUID, memory_id: UUID) -> str:
    """候補サムネイル（JPEG・幅320px）の storage_key。

    candidates/ の原画像に対応する軽量サムネ。パス規約は
    docs/data-contract.md §2 の thumbs/ に従う。
    """
    return f"{call_prefix(family_id, call_id)}thumbs/{memory_id}.jpg"


def album_video_key(family_id: UUID, call_id: UUID, version: int) -> str:
    """ハイライト動画（MP4）の storage_key。version は albums.version と一致。"""
    return f"{call_prefix(family_id, call_id)}albums/v{version}.mp4"


def album_collage_key(family_id: UUID, call_id: UUID, version: int) -> str:
    """コラージュ画像（JPEG）の storage_key。version は albums.version と一致。

    動画と同じく version をパスに含め、再生成時は上書きしない
    （SAS発行済みURLのキャッシュ取り違えを防ぐ。docs/data-contract.md §2）。
    """
    return f"{call_prefix(family_id, call_id)}albums/collage_v{version}.jpg"
