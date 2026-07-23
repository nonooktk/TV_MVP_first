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
    # 相手（高齢者側デバイス）の表示名（家族が設定・nullable）。通話画面の
    # Zoom 風ラベルに使う。未設定なら null（フロントはラベルを表示しない）。
    remote_display_name: str | None = None


class SpeechTokenResponse(BaseModel):
    token: str
    region: str
    expires_at: datetime


# --- calls --------------------------------------------------------------------


class CreateCallRequest(BaseModel):
    # device_id は省略可能（既知課題#5 対応・2026-07-05）。省略時はサーバ側で
    # 当該家族の status=active なデバイスへ自動解決する（複数件は最新 registered_at を採用）。
    device_id: UUID | None = None


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


class DeviceUpdateRequest(BaseModel):
    """デバイス表示名の更新リクエスト（PATCH /devices/{device_id}）。

    display_name は 30 文字までの表示名。空文字・空白のみは「未設定（null）」扱い。
    """

    display_name: str | None = Field(default=None, max_length=30)


class DeviceInfo(BaseModel):
    """自家族のデバイス情報（GET /devices・設定モーダルでの現在名表示用）。"""

    device_id: UUID
    display_name: str | None = None
    status: str
    registered_at: datetime | None = None


class DeviceList(BaseModel):
    items: list[DeviceInfo]


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
    # サムネイル（幅320px）閲覧用の短命 SAS URL。パス規約から導出して発行する
    # （存在チェックはしない。未生成時はフロントが sas_url にフォールバックする）。
    thumb_sas_url: str | None = None


class CandidateList(BaseModel):
    album_id: UUID
    presented_at: datetime | None = None
    auto_confirm_at: datetime | None = None
    candidates: list[Candidate]


class SelectionRequest(BaseModel):
    memory_ids: list[UUID] = Field(min_length=5, max_length=5)
    title: str | None = None
    caption: str | None = None


class AlbumPhoto(BaseModel):
    """アルバムの確定5枚のうち1枚（一覧表示用の軽量情報）。

    thumb_sas_url / sas_url はパス規約から導出して発行する（存在チェックはしない。
    thumb 未生成時はフロントが sas_url にフォールバックする）。
    """

    memory_id: UUID
    thumb_sas_url: str | None = None
    sas_url: str
    captured_at: datetime | None = None
    # 写真の取得元カメラ（両側連写・Phase 2）。"elder"=高齢者側／"family"=家族側（孫）。
    # memories.metadata.stream から導出する（過去データ＝未設定は None）。閲覧UIのバッジ用。
    stream: str | None = None


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
    # コラージュ画像（確定5枚から生成）の閲覧用 SAS URL（ready かつ存在時）。
    collage_sas_url: str | None = None
    version: int
    presented_at: datetime | None = None
    confirmed_at: datetime | None = None
    auto_confirmed: bool = False
    # 確定5枚（awaiting_selection では空配列）。一覧（GET /albums）でのみ設定する。
    # 個別取得系（latest / selection の応答）では省略（null）。
    photos: list[AlbumPhoto] | None = None


class AlbumList(BaseModel):
    items: list[AlbumResponse]
    next_cursor: str | None = None


# --- links --------------------------------------------------------------------


class RegisterLinkResponse(BaseModel):
    url: str
    expires_at: datetime
    one_time: bool = True
