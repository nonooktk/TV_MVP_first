// 委託コア②（検知キャプチャ）: 検知本体の配線（attachDetection）
//
// uid=2 の高齢者リモートストリーム（video/audio トラック）を受け取り、
//   - audioPipeline: RMS算出 → RmsTrigger（発火判定）＋ 音声スニペット構成
//   - facePipeline:  MediaPipe で face_score（選別指標）
//   - videoRing:     look-back コマ保持
// を配線する。発火時に連写10枚＋look-back＋音声スニペットを収集し、IndexedDB へ保存する。
//
// metadata は data-contract.md 付録キー（rms_db / rms_rise / face_score / trigger_reason /
// lookback）＋ captured_at を付ける。
//
// テスト用フック window.__detection = { forceTrigger(), state } を内蔵する。
// forceTrigger() は実発火と同じ経路（handleTrigger）を通す。

import { AudioPipeline } from "./audioPipeline";
import { captureBurst } from "./burst";
import { FacePipeline } from "./facePipeline";
import { NoopSttProvider, type SttProvider } from "./sttProvider";
import {
  RmsTrigger,
  type RmsTriggerEvent,
  type TriggerReason,
} from "./rmsTrigger";
import {
  saveAudio,
  savePhotos,
  type CaptureMetadata,
  type PhotoRecord,
} from "./storage";
import { VideoRing } from "./videoRing";

/** 発火時に外へ通知するイベント。 */
export interface DetectionEvent {
  reason: TriggerReason;
  /** 保存した写真枚数（連写＋look-back）。 */
  photoCount: number;
  /** 音声スニペットを保存できたか。 */
  hasAudio: boolean;
  /** 発火時の face_score。 */
  faceScore: number;
}

export interface AttachDetectionOptions {
  /** Agora の生 MediaStream（video/audio トラックを含む）。 */
  stream: MediaStream;
  /** 通話ID（IndexedDB の保存キー）。 */
  callId: string;
  /** 発火のたびに呼ばれる（バッジのフラッシュ・カウント表示に使う）。 */
  onEvent?: (ev: DetectionEvent) => void;
  /** STT プロバイダ（未指定なら noop=削減ラダー②）。 */
  stt?: SttProvider;
}

/** attach の戻り値。detach() で全リソースを解放する。 */
export interface DetectionHandle {
  detach: () => void;
}

/** window.__detection（テスト・観測用フック）の型。 */
export interface DetectionWindowHook {
  /** 実発火と同じ経路で1回発火させる（テスト用）。 */
  forceTrigger: () => Promise<void>;
  /** 現在の内部状態スナップショット。 */
  state: DetectionRuntimeState;
}

export interface DetectionRuntimeState {
  callId: string;
  running: boolean;
  triggerCount: number;
  lastFaceScore: number;
  /** 相手映像が連写できる状態か（videoWidth>0）。テストの発火タイミング判定に使う。 */
  videoReady: boolean;
  face: { loaded: boolean; failed: boolean; loadMs: number };
  audio: { hasHeader: boolean; ringChunks: number; mimeType: string };
  rms: {
    baselineDb: number | null;
    lastRmsDb: number | null;
    inCooldown: boolean;
  };
}

declare global {
  interface Window {
    __detection?: DetectionWindowHook;
  }
}

/**
 * 検知を配線する。video/audio トラックから RMS・表情・look-back を回し、
 * 発火時に連写＋音声スニペットを IndexedDB へ保存する。
 */
export function attachDetection(opts: AttachDetectionOptions): DetectionHandle {
  const { stream, callId, onEvent } = opts;
  const stt: SttProvider = opts.stt ?? new NoopSttProvider();

  // トラック取得。
  const videoTrack = stream.getVideoTracks()[0] ?? null;
  const audioTrack = stream.getAudioTracks()[0] ?? null;

  // 相手映像を流す隠し <video>（look-back / 連写 / 表情推論の共通ソース）。
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  if (videoTrack) {
    video.srcObject = new MediaStream([videoTrack]);
    void video.play().catch(() => {});
  }

  const rmsTrigger = new RmsTrigger();
  const videoRing = videoTrack ? new VideoRing(video) : null;
  const facePipeline = videoTrack ? new FacePipeline(video) : null;
  const audioPipeline = audioTrack
    ? new AudioPipeline(audioTrack, (db, now) => onRms(db, now))
    : null;

  let running = true;
  let triggerCount = 0;
  let busy = false; // 発火処理中の再入防止

  // --- 発火処理（実発火と forceTrigger の共通経路） --------------------------
  async function handleTrigger(ev: RmsTriggerEvent | null): Promise<void> {
    if (!running || busy) return;
    busy = true;
    const triggerAtMs = Date.now();
    const capturedAt = new Date(triggerAtMs).toISOString();
    const reason: TriggerReason = ev?.reason ?? "rms";
    const faceScore = facePipeline?.score() ?? 0;
    const faceTop = facePipeline?.topBlendshapes() ?? [];
    const sttResult = stt.latest();

    try {
      // 1) 連写＋look-back（video が無ければ空）。
      const lookback = videoRing?.snapshot() ?? [];
      const photos = video
        ? await captureBurst(video, lookback)
        : [];

      // 2) 音声スニペット（発火前2秒〜後3秒。audio が無ければ null）。
      const snippet = audioPipeline
        ? await audioPipeline.buildSnippet(triggerAtMs)
        : null;

      // 3) metadata 共通部（data-contract.md 付録キー）。
      const baseMeta: CaptureMetadata = {
        rms_db: ev?.rmsDb,
        rms_rise: ev?.rmsRise,
        face_score: faceScore,
        trigger_reason: reason,
        blendshapes_top: faceTop.length > 0 ? faceTop : undefined,
        stt_text: sttResult?.text,
        stt_labels: sttResult?.labels,
      };

      // 4) 写真を IndexedDB へ保存（lookback フラグは各コマ由来）。
      const photoRecords: Omit<PhotoRecord, "id">[] = photos.map((ph) => ({
        callId,
        blob: ph.blob,
        capturedAt: new Date(ph.capturedAtMs).toISOString(),
        metadata: { ...baseMeta, lookback: ph.lookback },
      }));
      if (photoRecords.length > 0) {
        await savePhotos(photoRecords);
      }

      // 5) 音声スニペットを IndexedDB へ保存。
      let hasAudio = false;
      if (snippet) {
        await saveAudio({
          callId,
          blob: snippet.blob,
          capturedAt,
          metadata: { ...baseMeta, lookback: false },
        });
        hasAudio = true;
      }

      triggerCount += 1;
      onEvent?.({
        reason,
        photoCount: photoRecords.length,
        hasAudio,
        faceScore,
      });
    } finally {
      busy = false;
    }
  }

  // --- RMS サンプル → 発火判定 ----------------------------------------------
  function onRms(rmsDb: number, nowMs: number): void {
    if (!running) return;
    const ev = rmsTrigger.push(rmsDb, nowMs);
    if (ev) {
      void handleTrigger(ev);
    }
  }

  // --- 起動 -----------------------------------------------------------------
  videoRing?.start();
  void facePipeline?.start(); // ロード失敗しても throw しない（best-effort）
  void stt.start(audioTrack!).catch(() => {});
  audioPipeline?.start();

  // --- テスト・観測用フック --------------------------------------------------
  function currentState(): DetectionRuntimeState {
    const rms = rmsTrigger.snapshot(Date.now());
    return {
      callId,
      running,
      triggerCount,
      lastFaceScore: facePipeline?.score() ?? 0,
      videoReady: !!videoTrack && video.videoWidth > 0,
      face: facePipeline?.status() ?? { loaded: false, failed: false, loadMs: 0 },
      audio:
        audioPipeline?.status() ?? {
          hasHeader: false,
          ringChunks: 0,
          mimeType: "",
        },
      rms: {
        baselineDb: rms.baselineDb,
        lastRmsDb: rms.lastRmsDb,
        inCooldown: rms.inCooldown,
      },
    };
  }

  if (typeof window !== "undefined") {
    window.__detection = {
      // forceTrigger は実発火と同じ handleTrigger を通す（reason は rms 相当）。
      forceTrigger: () => handleTrigger(null),
      get state() {
        return currentState();
      },
    } as DetectionWindowHook;
  }

  // --- 解放 -----------------------------------------------------------------
  function detach(): void {
    running = false;
    videoRing?.stop();
    facePipeline?.stop();
    audioPipeline?.stop();
    void stt.stop().catch(() => {});
    try {
      video.pause();
      video.srcObject = null;
    } catch {
      /* noop */
    }
    if (typeof window !== "undefined" && window.__detection) {
      // state は残す価値があるが、参照が消えるよう running=false のスナップショットに固定。
      const frozen = currentState();
      window.__detection = {
        forceTrigger: async () => {},
        state: frozen,
      };
    }
  }

  return { detach };
}

export type { CaptureMetadata } from "./storage";
