// 委託コア①（通話基盤）: Agora Web SDK 通話モジュール本体（M1）
//
// createClient → join(app_id, channel, token, uid) → ローカルカメラ/マイクの publish →
// リモートの subscribe/再生 → leave までを関数化する。
//
// - SDK はブラウザ専用のため dynamic import（呼び出し側は useEffect 内で使う）で SSR を回避する。
// - remote-user の published / left はコールバック（onRemoteVideo / onRemoteLeft）で上げる。
// - テスト用に window.__callState（joined / remoteVideo の有無）を更新するフックを内蔵する
//   （Playwright 自動通話テストが参照する。frontend/tests-e2e/）。
// - uid ルール: 家族=1・高齢者=2（backend の app/services/agora.py と一致）。
//   M2（検知コア②）は「uid=UID_ELDER(2) の高齢者ストリーム」に検知を接続する。
//   そのための差し込み口として onRemoteMediaStreamTrack で生 MediaStreamTrack を渡す。

import type {
  IAgoraRTCClient,
  IAgoraRTCRemoteUser,
  ICameraVideoTrack,
  IMicrophoneAudioTrack,
} from "agora-rtc-sdk-ng";

// uid ルール（backend: app/services/agora.py の UID_FAMILY / UID_ELDER と一致させる）
export const UID_FAMILY = 1;
export const UID_ELDER = 2;

/** テスト用に window へ公開する通話状態。 */
export interface CallState {
  joined: boolean;
  remoteVideo: boolean;
}

declare global {
  interface Window {
    __callState?: CallState;
  }
}

/** window.__callState を部分更新する（テスト観測用フック）。 */
function setCallState(patch: Partial<CallState>): void {
  if (typeof window === "undefined") return;
  const cur: CallState = window.__callState ?? { joined: false, remoteVideo: false };
  window.__callState = { ...cur, ...patch };
}

export interface StartCallOptions {
  /** Agora App ID（公開値）。/tokens/call・answer 応答の app_id を使う。 */
  appId: string;
  /** チャンネル名（通話ごとにサーバがローテーション生成）。 */
  channel: string;
  /** サーバ発行の短命トークン。 */
  token: string;
  /** 自分の uid（家族=UID_FAMILY / 高齢者=UID_ELDER）。 */
  uid: number;
  /** 相手映像を描画するコンテナ要素。 */
  remoteContainer: HTMLElement;
  /** 自分映像を描画するコンテナ要素（省略可）。 */
  localContainer?: HTMLElement | null;
  /** 相手の映像を受信して再生を開始したとき。 */
  onRemoteVideo?: (user: IAgoraRTCRemoteUser) => void;
  /** 相手がチャンネルから退出したとき（相手が通話を切った）。 */
  onRemoteLeft?: () => void;
  /**
   * M2（検知コア②）差し込み口: リモートの生 MediaStreamTrack を受け渡す。
   * uid=UID_ELDER(2) の高齢者ストリームに RMS音圧＋MediaPipe＋STT の検知を接続する予定。
   */
  onRemoteMediaStreamTrack?: (
    kind: "video" | "audio",
    track: MediaStreamTrack,
    uid: number
  ) => void;
}

/** 通話ハンドル。leave() で退出とリソース解放を行う。 */
export interface CallHandle {
  leave: () => Promise<void>;
}

/** カメラ/マイクの許可拒否エラーかを判定する（WF-02 例外画面の分岐に使う）。 */
export function isPermissionDenied(err: unknown): boolean {
  const e = err as { code?: string; name?: string; message?: string } | null;
  if (!e) return false;
  return (
    e.code === "PERMISSION_DENIED" ||
    e.name === "NotAllowedError" ||
    /permission denied/i.test(e.message ?? "")
  );
}

// join / leave の直列化。React Strict Mode（dev）の effect 二重実行で
// 「同一 uid の join が並行に走る」「join と leave が競合する」と UID_CONFLICT や
// 接続ハングを起こすため、(1) startCall 同士を op チェーンで順番に実行し、
// (2) 各実行の先頭で直前セッションの leave 完了を待つ。
let pendingLeave: Promise<void> = Promise.resolve();
let opChain: Promise<void> = Promise.resolve();

/**
 * 通話を開始する: join → ローカル publish → リモート subscribe/再生。
 *
 * 例外はそのまま throw する（カメラ/マイク拒否は isPermissionDenied で判定できる）。
 * 戻り値の leave() は冪等（多重呼び出し可）。
 */
export async function startCall(opts: StartCallOptions): Promise<CallHandle> {
  const run = opChain.then(() => doStartCall(opts));
  // 失敗しても後続の startCall を塞がない
  opChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function doStartCall(opts: StartCallOptions): Promise<CallHandle> {
  // 前の通話セッションの退出完了を待つ（失敗は無視して先へ進む）
  await pendingLeave.catch(() => {});

  // ブラウザ専用 SDK のため dynamic import（SSR 回避）
  const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
  AgoraRTC.setLogLevel(2); // WARNING 以上のみ（コンソールノイズ削減）

  const client: IAgoraRTCClient = AgoraRTC.createClient({
    mode: "rtc",
    codec: "vp8",
  });

  let micTrack: IMicrophoneAudioTrack | null = null;
  let camTrack: ICameraVideoTrack | null = null;
  let left = false;

  // 相手のメディアを受信したら購読して再生する
  client.on("user-published", async (user, mediaType) => {
    await client.subscribe(user, mediaType);
    if (mediaType === "video" && user.videoTrack) {
      user.videoTrack.play(opts.remoteContainer, { fit: "contain" });
      setCallState({ remoteVideo: true });
      opts.onRemoteVideo?.(user);
      opts.onRemoteMediaStreamTrack?.(
        "video",
        user.videoTrack.getMediaStreamTrack(),
        Number(user.uid)
      );
    }
    if (mediaType === "audio" && user.audioTrack) {
      user.audioTrack.play();
      opts.onRemoteMediaStreamTrack?.(
        "audio",
        user.audioTrack.getMediaStreamTrack(),
        Number(user.uid)
      );
    }
  });

  // 相手が映像の publish を止めた（カメラ停止など）
  client.on("user-unpublished", (_user, mediaType) => {
    if (mediaType === "video") {
      setCallState({ remoteVideo: false });
    }
  });

  // 相手がチャンネルから退出した（通話を切った・切断された）
  client.on("user-left", () => {
    setCallState({ remoteVideo: false });
    opts.onRemoteLeft?.();
  });

  const leave = async (): Promise<void> => {
    if (left) return;
    left = true;
    const p = (async () => {
      try {
        client.removeAllListeners();
        micTrack?.close();
        camTrack?.close();
        await client.leave();
      } finally {
        setCallState({ joined: false, remoteVideo: false });
      }
    })();
    pendingLeave = p.catch(() => {});
    return p;
  };

  try {
    // 先にカメラ/マイクの許可を取る（拒否時は join せずに例外を返すため）
    [micTrack, camTrack] = await AgoraRTC.createMicrophoneAndCameraTracks();

    await client.join(opts.appId, opts.channel, opts.token, opts.uid);

    if (opts.localContainer) {
      camTrack.play(opts.localContainer, { fit: "cover" });
    }
    await client.publish([micTrack, camTrack]);
    setCallState({ joined: true });
  } catch (err) {
    // 途中失敗時はリソースを確実に解放してから呼び出し元へ返す
    await leave();
    throw err;
  }

  return { leave };
}
