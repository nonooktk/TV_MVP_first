// FastAPI呼び出しの薄いクライアント（内製）
// 仕様は docs/api/openapi.yaml に準拠する
//
// 認証は2系統:
// - 家族側: Authorization: Bearer <lib/auth-stub.ts の固定トークン>
// - 高齢者側（デバイス）: X-Device-Token: <localStorage("device_token")>
//
// ベースURLは環境変数 NEXT_PUBLIC_API_BASE_URL（frontend/.env.local）。

import { getAuthToken } from "./auth-stub";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export const DEFAULT_DEVICE_ID = process.env.NEXT_PUBLIC_DEFAULT_DEVICE_ID ?? "";

const DEVICE_TOKEN_STORAGE_KEY = "device_token";

export function getDeviceToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY);
}

export function setDeviceToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, token);
}

// --- エラー型 -------------------------------------------------------------

export interface ApiErrorBody {
  code: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null, fallbackMessage: string) {
    super(body?.message ?? fallbackMessage);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type AuthMode = "family" | "device" | "none";

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  auth?: AuthMode;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

// fetchラッパー本体。認証ヘッダ付与・JSONパース・エラーハンドリングを一元化する。
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", auth = "family", body, query } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (auth === "family") {
    headers["Authorization"] = `Bearer ${getAuthToken()}`;
  } else if (auth === "device") {
    const token = getDeviceToken();
    if (!token) {
      throw new ApiError(401, {
        code: "no_device_token",
        message: "デバイストークンが登録されていません",
      }, "デバイストークンが登録されていません");
    }
    headers["X-Device-Token"] = token;
  }

  let url = `${API_BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let parsedBody: ApiErrorBody | null = null;
    try {
      const json = await res.json();
      // FastAPI の HTTPException(detail=...) は {"detail": {"code":..., "message":...}} の形。
      parsedBody = json.detail ?? json;
    } catch {
      parsedBody = null;
    }
    throw new ApiError(res.status, parsedBody, `APIエラー: ${res.status}`);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// --- 型定義（openapi.yaml のスキーマに対応） --------------------------------

export type CallStatus = "calling" | "active" | "ended";
export type MemoryType = "photo" | "audio";
export type MemoryStatus = "candidate" | "selected";
export type AlbumStatus = "awaiting_selection" | "generating" | "ready";

export interface Call {
  id: string;
  family_id: string;
  device_id: string;
  channel_name: string;
  status: CallStatus;
  started_at: string;
  ended_at: string | null;
}

export interface CallTokenResponse {
  token: string;
  channel_name: string;
  uid: number;
  expires_at: string;
  // Agora App ID（公開値）。SDK join に使う（M1・契約変更①）
  app_id: string;
}

export interface SpeechTokenResponse {
  token: string;
  region: string;
  expires_at: string;
}

export interface IncomingStatus {
  incoming: boolean;
  call_id: string | null;
  family_name: string | null;
}

export interface AnswerResponse {
  token: string;
  channel_name: string;
  uid: number;
  expires_at: string;
  // Agora App ID（公開値）。SDK join に使う（M1・契約変更①）
  app_id: string;
}

export interface Candidate {
  id: string;
  call_id: string;
  type: MemoryType;
  storage_key: string;
  score: number | null;
  status: MemoryStatus;
  captured_at: string;
  metadata: Record<string, unknown>;
  rank: number;
  sas_url: string;
}

export interface CandidateList {
  album_id: string;
  presented_at: string | null;
  auto_confirm_at: string | null;
  candidates: Candidate[];
}

export interface Album {
  id: string;
  call_id: string;
  status: AlbumStatus;
  selected_memory_ids: string[] | null;
  title: string | null;
  caption: string | null;
  bgm_track: string | null;
  video_storage_key: string | null;
  video_sas_url: string | null;
  version: number;
  presented_at: string | null;
  confirmed_at: string | null;
  auto_confirmed: boolean;
}

export interface AlbumList {
  items: Album[];
  next_cursor: string | null;
}

export interface RegisterLinkResponse {
  url: string;
  expires_at: string;
  one_time: boolean;
}

export interface DeviceRegisterResponse {
  device_token: string;
}

export interface MediaRegisterItem {
  type: MemoryType;
  storage_key: string;
  captured_at: string;
  metadata?: Record<string, unknown>;
}

export interface MediaRegisterResponse {
  memory_ids: string[];
}

export interface UploadSasItem {
  filename: string;
  storage_key: string;
  upload_url: string;
}

export interface UploadSasResponse {
  items: UploadSasItem[];
  expires_at: string;
}

// --- tokens -----------------------------------------------------------------

export async function issueCallToken(callId: string): Promise<CallTokenResponse> {
  return request<CallTokenResponse>("/tokens/call", {
    method: "POST",
    auth: "family",
    body: { call_id: callId },
  });
}

export async function issueSpeechToken(): Promise<SpeechTokenResponse> {
  return request<SpeechTokenResponse>("/tokens/speech", {
    method: "POST",
    auth: "family",
  });
}

// --- calls --------------------------------------------------------------------

export async function createCall(deviceId: string): Promise<Call> {
  return request<Call>("/calls", {
    method: "POST",
    auth: "family",
    body: { device_id: deviceId },
  });
}

export async function pollIncomingCall(): Promise<IncomingStatus> {
  return request<IncomingStatus>("/calls/incoming", {
    method: "GET",
    auth: "device",
  });
}

export async function answerCall(callId: string): Promise<AnswerResponse> {
  return request<AnswerResponse>(`/calls/${callId}/answer`, {
    method: "POST",
    auth: "device",
  });
}

// 通話終了（M1・契約変更②）。家族（family）・高齢者デバイス（device）の
// どちらの認証でも呼べる。既に ended の場合も 200（冪等）。
export async function endCall(
  callId: string,
  auth: "family" | "device"
): Promise<Call> {
  return request<Call>(`/calls/${callId}/end`, {
    method: "POST",
    auth,
  });
}

// --- media --------------------------------------------------------------------

export async function registerMedia(
  callId: string,
  items: MediaRegisterItem[]
): Promise<MediaRegisterResponse> {
  return request<MediaRegisterResponse>("/media/register", {
    method: "POST",
    auth: "family",
    body: { call_id: callId, items },
  });
}

export async function issueUploadSas(
  callId: string,
  filenames: string[]
): Promise<UploadSasResponse> {
  return request<UploadSasResponse>("/media/upload-sas", {
    method: "POST",
    auth: "family",
    body: { call_id: callId, filenames },
  });
}

// --- albums / candidates / selection ------------------------------------------

export async function getCandidates(callId: string): Promise<CandidateList> {
  return request<CandidateList>(`/calls/${callId}/candidates`, {
    method: "GET",
    auth: "family",
  });
}

export async function submitSelection(
  callId: string,
  memoryIds: string[]
): Promise<Album> {
  return request<Album>(`/calls/${callId}/selection`, {
    method: "POST",
    auth: "family",
    body: { memory_ids: memoryIds },
  });
}

export async function getLatestAlbum(): Promise<Album> {
  return request<Album>("/albums/latest", {
    method: "GET",
    auth: "device",
  });
}

export async function getAlbums(
  cursor?: string,
  limit?: number
): Promise<AlbumList> {
  return request<AlbumList>("/albums", {
    method: "GET",
    auth: "family",
    query: { cursor, limit },
  });
}

// --- links / devices ------------------------------------------------------------

export async function registerLink(): Promise<RegisterLinkResponse> {
  return request<RegisterLinkResponse>("/links/register", {
    method: "POST",
    auth: "family",
  });
}

export async function registerDevice(
  registrationToken: string
): Promise<DeviceRegisterResponse> {
  return request<DeviceRegisterResponse>("/devices/register", {
    method: "POST",
    auth: "none",
    body: { registration_token: registrationToken },
  });
}
