"""API のリクエスト/レスポンス スキーマ（Pydantic）。

docs/api/openapi.yaml のスキーマに対応する。追加2エンドポイント
（POST /devices/register・POST /media/upload-sas）のスキーマもここに定義する。
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


# --- tokens -------------------------------------------------------------------


class CallTokenRequest(BaseModel):
    call_id: UUID


class CallTokenResponse(BaseModel):
    token: str
    channel_name: str
    uid: int
    expires_at: datetime
    # Agora App ID（公開値）。フロントの SDK join に必要（契約変更①・M1）。
    app_id: str


class SpeechTokenResponse(BaseModel):
    token: str
    region: str
    expires_at: datetime


# --- calls --------------------------------------------------------------------


class CreateCallRequest(BaseModel):
    device_id: UUID


class CallResponse(BaseModel):
    id: UUID
    family_id: UUID
    device_id: UUID
    channel_name: str
    status: str
    started_at: datetime | None = None
    ended_at: datetime | None = None


class IncomingStatus(BaseModel):
    incoming: bool
    call_id: UUID | None = None
    family_name: str | None = None


class AnswerResponse(BaseModel):
    token: str
    channel_name: str
    uid: int
    expires_at: datetime
    # Agora App ID（公開値）。フロントの SDK join に必要（契約変更①・M1）。
    app_id: str


# --- devices（追加）-----------------------------------------------------------


class DeviceRegisterRequest(BaseModel):
    registration_token: str


class DeviceRegisterResponse(BaseModel):
    device_token: str


# --- media --------------------------------------------------------------------


class MediaRegisterItem(BaseModel):
    type: str  # photo / audio
    storage_key: str
    captured_at: datetime
    metadata: dict = Field(default_factory=dict)


class MediaRegisterRequest(BaseModel):
    call_id: UUID
    items: list[MediaRegisterItem] = Field(min_length=1)


class MediaRegisterResponse(BaseModel):
    memory_ids: list[UUID]


class UploadSasRequest(BaseModel):
    call_id: UUID
    filenames: list[str] = Field(min_length=1)


class UploadSasItem(BaseModel):
    filename: str
    storage_key: str
    upload_url: str


class UploadSasResponse(BaseModel):
    items: list[UploadSasItem]
    expires_at: datetime


# --- candidates / selection / albums ------------------------------------------


class Candidate(BaseModel):
    id: UUID
    call_id: UUID
    type: str
    storage_key: str
    score: float | None = None
    status: str
    captured_at: datetime
    metadata: dict = Field(default_factory=dict)
    rank: int
    sas_url: str


class CandidateList(BaseModel):
    album_id: UUID
    presented_at: datetime | None = None
    auto_confirm_at: datetime | None = None
    candidates: list[Candidate]


class SelectionRequest(BaseModel):
    memory_ids: list[UUID] = Field(min_length=5, max_length=5)
    title: str | None = None
    caption: str | None = None


class AlbumResponse(BaseModel):
    id: UUID
    call_id: UUID
    status: str
    selected_memory_ids: list[UUID] | None = None
    title: str | None = None
    caption: str | None = None
    bgm_track: str | None = None
    video_storage_key: str | None = None
    video_sas_url: str | None = None
    version: int
    presented_at: datetime | None = None
    confirmed_at: datetime | None = None
    auto_confirmed: bool = False


class AlbumList(BaseModel):
    items: list[AlbumResponse]
    next_cursor: str | None = None


# --- links --------------------------------------------------------------------


class RegisterLinkResponse(BaseModel):
    url: str
    expires_at: datetime
    one_time: bool = True
