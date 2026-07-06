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
  ICameraVideoTrack,
  IAgoraRTCRemoteUser,
  ILocalAudioTrack,
  IMicrophoneAudioTrack,
} from "agora-rtc-sdk-ng";

import { SlowGainNormalizer } from "./autoGain";

// uid ルール（backend: app/services/agora.py の UID_FAMILY / UID_ELDER と一致させる）
export const UID_FAMILY = 1;
export const UID_ELDER = 2;

/** テスト用に window へ公開する通話状態。 */
export interface CallState {
  joined: boolean;
  remoteVideo: boolean;
}

/** デバッグパネル用: 自動ゲインの観測値（高齢者側=window.__autoGain / 家族側=window.__autoGainFamily）。 */
export interface AutoGainDebugState {
  /** 有効か（WebAudio グラフが構築できたとき true）。 */
  enabled: boolean;
  /** マイク入力の測定レベル（dBFS）。 */
  measuredDbfs: number | null;
  /** 有声 RMS の EMA（dBFS）。 */
  emaDbfs: number | null;
  /** 適用中のゲイン（dB）。 */
  gainDb: number;
}

declare global {
  interface Window {
    __callState?: CallState;
    /** 高齢者側（uid=2）の自動ゲイン観測値。既存キー名を後方互換で維持する。 */
    __autoGain?: AutoGainDebugState;
    /** 家族側（uid=1）の自動ゲイン観測値（2026-07-07 家族側適用で追加）。 */
    __autoGainFamily?: AutoGainDebugState;
  }
}

/** 自動ゲイン観測値の書き込み先（elder=既存 window.__autoGain / family=window.__autoGainFamily）。 */
type AutoGainSide = "elder" | "family";

/** window.__autoGain（elder）/ window.__autoGainFamily（family）を設定する（観測用フック）。 */
function setAutoGainState(
  side: AutoGainSide,
  patch: Partial<AutoGainDebugState>
): void {
  if (typeof window === "undefined") return;
  const key = side === "elder" ? "__autoGain" : "__autoGainFamily";
  const cur: AutoGainDebugState = window[key] ?? {
    enabled: false,
    measuredDbfs: null,
    emaDbfs: null,
    gainDb: 0,
  };
  window[key] = { ...cur, ...patch };
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

/**
 * マイクの自動ゲイン用 WebAudio グラフを構築する（両側共通・2026-07-07 に家族側へも適用拡大）。
 *
 * 生マイク → MediaStreamSource → [AnalyserNode（測定）／GainNode（適用）] →
 * MediaStreamDestination → その出力ストリームの音声トラックを Agora の
 * カスタムオーディオトラックとして publish する。
 *
 * - 約50ms間隔で Analyser から RMS(dBFS) を測り SlowGainNormalizer へ投入する。
 * - normalizer の出力ゲイン（dB→倍率）を GainNode に **setTargetAtTime** で滑らかに反映する
 *   （normalizer 自体もスルーレート制限済み＝二重に急変を避ける）。
 * - WebAudio 構築に失敗した場合は null を返す（呼び出し側は生マイクをそのまま publish する）。
 *
 * echoCancellation は生マイク側の既定を維持、AGC は false 据え置き（呼び出し側の micConfig）。
 * この自動ゲインは AGC の代替ではなく、**ゆっくりした発話レベル正規化**（相対上昇検知を壊さない）。
 */
interface AutoGainPipeline {
  /** publish 用のカスタムオーディオトラック（MediaStreamDestination 由来）。 */
  track: ILocalAudioTrack;
  /** 解放（interval 停止・AudioContext close）。 */
  stop: () => void;
}

async function buildAutoGainPipeline(
  AgoraRTC: typeof import("agora-rtc-sdk-ng").default,
  micTrack: IMicrophoneAudioTrack,
  side: AutoGainSide
): Promise<AutoGainPipeline | null> {
  try {
    const AudioCtor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const audioCtx = new AudioCtor();

    // 生マイクの MediaStreamTrack から WebAudio の入力を作る。
    const rawTrack = micTrack.getMediaStreamTrack();
    const srcStream = new MediaStream([rawTrack]);
    const source = audioCtx.createMediaStreamSource(srcStream);

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    const gainNode = audioCtx.createGain();
    const dest = audioCtx.createMediaStreamDestination();

    // 分岐: source → analyser（測定・行き止まり）／ source → gain → dest（適用・publish）。
    source.connect(analyser);
    source.connect(gainNode);
    gainNode.connect(dest);
    gainNode.gain.value = 1; // 初期 0dB（素通し）

    const outTrack = dest.stream.getAudioTracks()[0];
    if (!outTrack) {
      void audioCtx.close().catch(() => {});
      return null;
    }
    const customTrack = AgoraRTC.createCustomAudioTrack({
      mediaStreamTrack: outTrack,
    });

    const normalizer = new SlowGainNormalizer();
    const buf = new Float32Array(analyser.fftSize);
    setAutoGainState(side, { enabled: true, gainDb: 0, measuredDbfs: null, emaDbfs: null });

    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
      const rms = Math.sqrt(sumSq / buf.length);
      const dbfs = rms > 1e-7 ? 20 * Math.log10(rms) : -100;
      const now = Date.now();
      normalizer.pushSample(dbfs, now);
      const gainDb = normalizer.targetGainDb();
      // GainNode へ滑らかに反映（±2dB/更新のスルーレートに加え、時定数でさらに滑らかに）。
      try {
        gainNode.gain.setTargetAtTime(
          normalizer.targetGainLinear(),
          audioCtx.currentTime,
          0.2
        );
      } catch {
        gainNode.gain.value = normalizer.targetGainLinear();
      }
      const snap = normalizer.snapshot();
      setAutoGainState(side, {
        enabled: true,
        measuredDbfs: dbfs,
        emaDbfs: snap.emaDbfs,
        gainDb,
      });
    }, 50);

    const stop = (): void => {
      clearInterval(timer);
      try {
        source.disconnect();
        analyser.disconnect();
        gainNode.disconnect();
      } catch {
        /* noop */
      }
      try {
        customTrack.close();
      } catch {
        /* noop */
      }
      void audioCtx.close().catch(() => {});
      setAutoGainState(side, { enabled: false });
    };

    return { track: customTrack, stop };
  } catch (e) {
    // WebAudio 構築失敗時は自動ゲインなしで続行（生マイクを publish）。
    // eslint-disable-next-line no-console
    console.warn("[call] 自動ゲイン WebAudio の構築に失敗（生マイクで続行）", e);
    return null;
  }
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
  // 自動ゲイン用パイプライン（両側。publish するカスタムトラック＋WebAudio 解放）。
  let autoGain: AutoGainPipeline | null = null;
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
        autoGain?.stop(); // 自動ゲインの interval / AudioContext を先に止める
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
    //
    // 【マイク AGC 無効化（両側・2026-07-07 に家族側へ統一）】
    // - 高齢者側（uid=UID_ELDER）: 検知（家族側ブラウザの RMS音圧トリガー）は「高齢者側
    //   リモート音声」を見て発火する。AGC が効くと声を張っても送信側で平滑化され、
    //   baseline 比の相対上昇（rms_rise）が出にくくなるため無効化（detection-params.md
    //   の支給仕様「AGC=オフ（送信側で設定）」）。
    // - 家族側（uid=UID_FAMILY）: 自前のゆっくり正規化（SlowGainNormalizer）を家族側にも
    //   適用するため、Agora AGC との**二重調整を避ける**目的で同じく無効化する。
    // AEC（エコーキャンセル）は両側とも既定どおり維持、ANS（ノイズ抑制）も既定のまま。
    const micConfig = { AGC: false as const };
    [micTrack, camTrack] = await AgoraRTC.createMicrophoneAndCameraTracks(
      micConfig
    );

    await client.join(opts.appId, opts.channel, opts.token, opts.uid);

    if (opts.localContainer) {
      camTrack.play(opts.localContainer, { fit: "cover" });
    }

    // 【自動ゲイン（B）・両側適用（2026-07-07 に家族側へ拡大）】:
    // マイク → WebAudio（測定＋GainNode）→ MediaStreamDestination →
    // カスタムオーディオトラックで publish する。観測値の書き込み先は
    // 高齢者側=window.__autoGain（後方互換）/ 家族側=window.__autoGainFamily。
    // 構築に失敗した場合は、生マイクをそのまま publish する（従来どおりのフォールバック）。
    let audioToPublish: IMicrophoneAudioTrack | ILocalAudioTrack = micTrack;
    const side: AutoGainSide = opts.uid === UID_ELDER ? "elder" : "family";
    autoGain = await buildAutoGainPipeline(AgoraRTC, micTrack, side);
    if (autoGain) {
      // 生マイクは publish せず（WebAudio の入力としてのみ使う）、正規化後トラックを publish。
      audioToPublish = autoGain.track;
    }

    await client.publish([audioToPublish, camTrack]);
    setCallState({ joined: true });
  } catch (err) {
    // 途中失敗時はリソースを確実に解放してから呼び出し元へ返す
    await leave();
    throw err;
  }

  return { leave };
}
