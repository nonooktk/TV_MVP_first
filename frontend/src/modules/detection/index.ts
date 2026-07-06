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
import { AzureSttProvider, type SttRuntimeState } from "./azureSttProvider";
import { passesSharedCooldown } from "./sttConfig";
import type { SttProvider } from "./sttProvider";
import { DEFAULT_RMS_PARAMS } from "./rmsTrigger";
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

/**
 * 発火キャプチャ（連写＋スニペット＋保存）全体の上限時間（ms・修正1）。
 * buildSnippet の内部タイムアウト（6s）＋保存の余裕を見込んで 8s。
 * これを超えたら撮れたぶんだけ保存して busy を解除し、次の発火を生かす。
 */
export const CAPTURE_TIMEOUT_MS = 8000;

/**
 * task を timeoutMs で打ち切る競争を行う純粋ヘルパ（修正1・テスト容易性のため独立関数）。
 *
 * - task が timeoutMs 以内に settle → `"ok"`（例外時は "error" ＋ 例外を投げずに返す）
 * - timeoutMs を超えても task が settle しない → `"timeout"`（task は放置＝ハングしても
 *   呼び出し側は必ず制御を取り戻す）
 *
 * これにより handleTrigger は「settle しない await（buildSnippet のハング等）」でも必ず
 * 抜けて busy を解除できる。task が投げた場合は "error"（呼び出し側で撮れたぶんを保存する）。
 */
export async function raceWithTimeout(
  task: Promise<unknown>,
  timeoutMs: number
): Promise<"ok" | "timeout" | "error"> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const wrapped = task.then(
    () => "ok" as const,
    () => "error" as const
  );
  const result = await Promise.race([wrapped, timeout]);
  if (timer !== null) clearTimeout(timer);
  return result;
}

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

/** 表情検知の稼働状態（バッジ表示用）。 */
export type FaceHealthState = "loading" | "failed" | "no_face" | "ok";

export interface AttachDetectionOptions {
  /** Agora の生 MediaStream（video/audio トラックを含む）。 */
  stream: MediaStream;
  /** 通話ID（IndexedDB の保存キー）。 */
  callId: string;
  /** 発火のたびに呼ばれる（バッジのフラッシュ・カウント表示に使う）。 */
  onEvent?: (ev: DetectionEvent) => void;
  /**
   * 表情検知の稼働状態が変わるたびに呼ばれる（通話画面バッジに「顔検知OK/停止中」を出す用）。
   * 約1秒間隔でポーリングし、状態が変化したときのみ通知する。
   * reason は failed のときの理由文字列（バッジ title・停止理由の併記用。他状態では null）。
   */
  onFaceHealth?: (state: FaceHealthState, reason: string | null) => void;
  /**
   * STT プロバイダ。未指定なら AzureSttProvider（best-effort）を使う。
   * Speech 未設定（Fake トークン）や SDK ロード失敗では STT 無効のまま通話・RMS検知を継続する。
   * テストで STT を完全に無効化したい場合は NoopSttProvider を渡す。
   */
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
  /** 発火処理中（キャプチャ中）か。デバッグパネル用。 */
  busy: boolean;
  lastFaceScore: number;
  /** 相手映像が連写できる状態か（videoWidth>0）。テストの発火タイミング判定に使う。 */
  videoReady: boolean;
  face: {
    loaded: boolean;
    failed: boolean;
    loadMs: number;
    source: "cdn" | "local" | null;
    reason: string | null;
  };
  /**
   * 表情検知の稼働状態（バッジ・観測用）。
   * loading=ロード中 / failed=ロード失敗 / no_face=顔未検出 / ok=顔検出中。
   */
  faceHealth: "loading" | "failed" | "no_face" | "ok";
  /**
   * 表情検知が停止（failed）している場合の理由（バッジ title・ログ用）。
   * failed 以外では null。`window.__detection.state.face.reason` からも参照可能。
   */
  faceReason: string | null;
  audio: { hasHeader: boolean; ringChunks: number; mimeType: string };
  rms: {
    baselineDb: number | null;
    lastRmsDb: number | null;
    inCooldown: boolean;
    /** baseline 比の相対上昇量（dB）。baseline 未確立または未サンプルは null。 */
    riseDb: number | null;
    /** 上昇状態の持続累積（ms）。sustainMs に達すると発火する。 */
    sustainedMs: number;
    /** クールダウン残り（ms）。0 なら発火可能。デバッグパネルの秒表示に使う。 */
    cooldownRemainingMs: number;
    /** 現在の VAD 床（dB）。audioPipeline のノイズフロア推定で自動更新される（item 12）。 */
    vadFloorDb: number;
    /** baseline ウォームアップ中か（有声累計 < warmupMs＝速い τ で順応中）。デバッグパネル用。 */
    inWarmup: boolean;
  };
  /** STT（感情ワード検知）の状態。STT 無効時は enabled=false。 */
  stt: SttRuntimeState;
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
  const { stream, callId, onEvent, onFaceHealth } = opts;

  // RMS発火と STT発火で共有するクールダウン（連打防止）。
  // rmsTrigger は内部クールダウンを持つが、STT は別経路のため、直近発火時刻を
  // 共有チェックして「どちらかが発火したら SHARED_COOLDOWN_MS は次を抑止」する。
  // 値は RMS のクールダウン（4s）に合わせる。
  const SHARED_COOLDOWN_MS = DEFAULT_RMS_PARAMS.cooldownMs; // 4000ms
  let lastTriggerAtMs = 0;

  // STT プロバイダ。未指定なら AzureSttProvider（best-effort・感情ワードで stt 発火）。
  const stt: SttProvider =
    opts.stt ??
    new AzureSttProvider({
      onEmotionHit: (_hits, _text) => {
        // 感情ワードヒット → 共有クールダウンを通過したら stt 発火。
        void handleTrigger(null, "stt");
      },
    });

  // トラック取得。
  const videoTrack = stream.getVideoTracks()[0] ?? null;
  const audioTrack = stream.getAudioTracks()[0] ?? null;

  // 相手映像を流す隠し <video>（look-back / 連写 / 表情推論の共通ソース）。
  // muted+playsInline+autoplay で autoplay 制約を回避する。play() は失敗し得る
  // （autoplay ポリシー・トラック未確立）ため、loadedmetadata / canplay を機に再試行し、
  // 失敗はログに残す（無限「起動中」の一因＝映像フレーム未到達を観測可能にする）。
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  if (videoTrack) {
    video.srcObject = new MediaStream([videoTrack]);
    const tryPlay = (): void => {
      const pr = video.play();
      if (pr && typeof pr.catch === "function") {
        pr.catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.warn("[detection] 検知用 video の再生開始に失敗（再試行する）", e);
        });
      }
    };
    // 初回 + メタデータ到達 + 再生可能になった各タイミングで再生を試みる。
    tryPlay();
    video.addEventListener("loadedmetadata", tryPlay);
    video.addEventListener("canplay", tryPlay);
  }

  const rmsTrigger = new RmsTrigger();
  const videoRing = videoTrack ? new VideoRing(video) : null;
  const facePipeline = videoTrack ? new FacePipeline(video) : null;
  const audioPipeline = audioTrack
    ? new AudioPipeline(
        audioTrack,
        (db, now) => onRms(db, now),
        {},
        // 家族側 VAD 床の自動化（item 12）: ノイズフロア推定 → 床=ノイズ+8dB を rmsTrigger へ反映。
        (vadFloorDb) => rmsTrigger.setVadFloorDb(vadFloorDb)
      )
    : null;

  let running = true;
  let triggerCount = 0;
  let busy = false; // 発火処理中の再入防止

  // --- 発火処理（実発火と forceTrigger の共通経路） --------------------------
  // reasonOverride を渡すと ev の reason より優先する（STT 発火は ev=null＋"stt"）。
  async function handleTrigger(
    ev: RmsTriggerEvent | null,
    reasonOverride?: TriggerReason
  ): Promise<void> {
    if (!running || busy) return;
    const triggerAtMs = Date.now();
    // 共有クールダウン: 直近発火から SHARED_COOLDOWN_MS 未満は抑止（RMS/STT 連打防止）。
    // forceTrigger（テスト）は reasonOverride=undefined & ev=null で来るため抑止しない。
    const isSttOrRms = reasonOverride === "stt" || ev !== null;
    if (
      isSttOrRms &&
      !passesSharedCooldown(triggerAtMs, lastTriggerAtMs, SHARED_COOLDOWN_MS)
    ) {
      return;
    }
    busy = true;
    lastTriggerAtMs = triggerAtMs;
    const capturedAt = new Date(triggerAtMs).toISOString();
    const reason: TriggerReason = reasonOverride ?? ev?.reason ?? "rms";
    const faceScore = facePipeline?.score() ?? 0;
    const faceTop = facePipeline?.topBlendshapes() ?? [];
    const sttResult = stt.latest();

    // metadata 共通部（data-contract.md 付録キー）。
    // face_score は各コマ固有（下の map で上書き）なので base には発火時点値を入れる。
    const baseMeta: CaptureMetadata = {
      rms_db: ev?.rmsDb,
      rms_rise: ev?.rmsRise,
      face_score: faceScore,
      trigger_reason: reason,
      blendshapes_top: faceTop.length > 0 ? faceTop : undefined,
      stt_text: sttResult?.text,
      stt_labels: sttResult?.labels,
    };

    // 【修正1: 発火 busy 永久化の根絶】
    // キャプチャ部（連写＋スニペット＋保存）全体を CAPTURE_TIMEOUT_MS の Promise.race で包む。
    // どこかの await が settle しない（例: buildSnippet がチャンクを待ち続ける）場合でも、
    // 全体タイムアウトで必ず抜けて busy を解除し、次の発火を生かす。
    // タイムアウト時は「どの段階（burst / snippet / save）まで進んだか」を console.warn し、
    // 撮れたぶんだけ保存を試みる（部分成果を捨てない）。
    // 進捗・部分成果は 1 つの可変ホルダに集約する（closure 内の代入を TS が変数側の
    // 型として narrowing しないよう、プロパティ経由でアクセスする）。
    const prog: {
      stage: "burst" | "snippet" | "save" | "done";
      capturedPhotos: Omit<PhotoRecord, "id">[] | null; // 保存前に退避した写真
      capturedSnippet: { blob: Blob; mimeType: string } | null;
      savedPhotos: boolean;
      savedAudio: boolean;
      photoCount: number;
    } = {
      stage: "burst",
      capturedPhotos: null,
      capturedSnippet: null,
      savedPhotos: false,
      savedAudio: false,
      photoCount: 0,
    };

    const capture = async (): Promise<void> => {
      // 1) 連写＋look-back（video が無ければ空）。
      //    face_score も rms_db/rms_rise（音圧）も「発火瞬間の1値共有」ではなく
      //    **各ショット時点** を採点する（burst の sampleFaceScore / sampleRms）。
      //    look-back コマは撮影が過去のため発火時点の直近値を共有する。
      //    音圧のコマ別採点により、無表情環境（face_score が全0）でも連写内に
      //    自然な差がつき、候補が全員同点になるのを防ぐ（stage1 は per-photo の
      //    rms_rise を使うため worker 側の変更は不要）。
      prog.stage = "burst";
      const lookback = videoRing?.snapshot() ?? [];
      const triggerRms = { rmsDb: ev?.rmsDb, rmsRise: ev?.rmsRise };
      const photos = video
        ? await captureBurst(
            video,
            lookback,
            {},
            {
              sampleFaceScore: () => facePipeline?.score() ?? 0,
              lookbackFaceScore: faceScore,
              sampleRms: () => {
                const s = rmsTrigger.sample();
                // null（未サンプル）は metadata に載せない＝undefined へ変換する。
                return {
                  rmsDb: s.rmsDb ?? undefined,
                  rmsRise: s.rmsDb === null ? undefined : s.rmsRise,
                };
              },
              lookbackRms: triggerRms,
            }
          )
        : [];

      // 写真レコードを組み立てて退避（後段でタイムアウトしても salvage で保存を試みる）。
      // lookback フラグ・face_score・rms_db/rms_rise は各コマ由来（コマごと採点）。
      // 各値が無い場合（sample* 未指定経路）は発火時点値=baseMeta へフォールバックする。
      prog.capturedPhotos = photos.map((ph) => ({
        callId,
        blob: ph.blob,
        capturedAt: new Date(ph.capturedAtMs).toISOString(),
        metadata: {
          ...baseMeta,
          lookback: ph.lookback,
          face_score: ph.faceScore ?? faceScore,
          rms_db: ph.rms?.rmsDb ?? baseMeta.rms_db,
          rms_rise: ph.rms?.rmsRise ?? baseMeta.rms_rise,
        },
      }));

      // 2) 音声スニペット（発火前2秒〜後3秒。audio が無ければ null）。
      //    buildSnippet 自体にも内部タイムアウト（発火6s）があるため通常はここで詰まらない。
      prog.stage = "snippet";
      prog.capturedSnippet = audioPipeline
        ? await audioPipeline.buildSnippet(triggerAtMs)
        : null;

      // 3) IndexedDB へ保存（写真→音声の順）。
      prog.stage = "save";
      if (prog.capturedPhotos.length > 0) {
        await savePhotos(prog.capturedPhotos);
        prog.savedPhotos = true;
        prog.photoCount = prog.capturedPhotos.length;
      }
      if (prog.capturedSnippet) {
        await saveAudio({
          callId,
          blob: prog.capturedSnippet.blob,
          capturedAt,
          metadata: { ...baseMeta, lookback: false },
        });
        prog.savedAudio = true;
      }
      prog.stage = "done";
    };

    // タイムアウト／例外時に「撮れたぶんだけ保存」を試みる（save 前に切れた場合の保険）。
    const salvage = async (): Promise<void> => {
      try {
        if (!prog.savedPhotos && prog.capturedPhotos && prog.capturedPhotos.length > 0) {
          await savePhotos(prog.capturedPhotos);
          prog.savedPhotos = true;
          prog.photoCount = prog.capturedPhotos.length;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[detection] タイムアウト後の写真サルベージ保存に失敗", e);
      }
      try {
        if (!prog.savedAudio && prog.capturedSnippet) {
          await saveAudio({
            callId,
            blob: prog.capturedSnippet.blob,
            capturedAt,
            metadata: { ...baseMeta, lookback: false },
          });
          prog.savedAudio = true;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[detection] タイムアウト後の音声サルベージ保存に失敗", e);
      }
    };

    try {
      // capture 全体を CAPTURE_TIMEOUT_MS で打ち切る（settle しない await でも必ず抜ける）。
      const outcome = await raceWithTimeout(capture(), CAPTURE_TIMEOUT_MS);
      if (outcome === "timeout") {
        // 全体タイムアウト: どの段階まで進んだかを出し、撮れたぶんの保存を試みる。
        // eslint-disable-next-line no-console
        console.warn(
          `[detection] 発火キャプチャが ${CAPTURE_TIMEOUT_MS}ms で全体タイムアウト（段階=${prog.stage}` +
            `／photos退避=${prog.capturedPhotos?.length ?? 0}枚・snippet=${
              prog.capturedSnippet ? "有" : "無"
            }）。撮れたぶんだけ保存し busy を解除して次の発火を生かす`
        );
        await salvage();
      } else if (outcome === "error") {
        // capture 内の予期しない例外。撮れたぶんの保存を試みる（busy は finally で必ず解除）。
        // eslint-disable-next-line no-console
        console.warn(
          `[detection] 発火キャプチャで例外（段階=${prog.stage}）。撮れたぶんを保存する`
        );
        await salvage();
      }
    } finally {
      busy = false;
    }

    // 部分成果でも保存できていれば発火として通知・カウントする。
    if (prog.savedPhotos || prog.savedAudio) {
      triggerCount += 1;
      onEvent?.({
        reason,
        photoCount: prog.photoCount,
        hasAudio: prog.savedAudio,
        faceScore,
      });
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
  // STT は音声トラックがある場合のみ起動（best-effort・失敗しても通話継続）。
  if (audioTrack) {
    void stt.start(audioTrack).catch(() => {});
  }
  audioPipeline?.start();

  // --- 表情検知の稼働状態ポーリング（バッジ用） -----------------------------
  // 約1秒間隔で face の health を見て、状態が変わったら onFaceHealth へ通知する。
  let lastFaceHealth: FaceHealthState | null = null;
  const FACE_HEALTH_POLL_MS = 1000;
  const faceHealthTimer: ReturnType<typeof setInterval> | null =
    onFaceHealth && videoTrack
      ? setInterval(() => {
          const h = facePipeline?.health() ?? { state: "failed", reason: null };
          const st = h.state;
          if (st !== lastFaceHealth) {
            lastFaceHealth = st;
            // failed のときは reason を併せて通知する（バッジに短い理由を併記する用）。
            onFaceHealth(st, st === "failed" ? h.reason : null);
            if (st === "failed" && h.reason) {
              // eslint-disable-next-line no-console
              console.warn(`[detection] 表情検知が停止中: ${h.reason}`);
            }
          }
        }, FACE_HEALTH_POLL_MS)
      : null;

  // --- テスト・観測用フック --------------------------------------------------
  function currentState(): DetectionRuntimeState {
    const rms = rmsTrigger.snapshot(Date.now());
    return {
      callId,
      running,
      triggerCount,
      busy,
      lastFaceScore: facePipeline?.score() ?? 0,
      videoReady: !!videoTrack && video.videoWidth > 0,
      face:
        facePipeline?.status() ?? {
          loaded: false,
          failed: false,
          loadMs: 0,
          source: null,
          reason: null,
        },
      faceHealth: facePipeline?.health().state ?? "failed",
      faceReason: facePipeline?.health().reason ?? null,
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
        riseDb: rms.riseDb,
        sustainedMs: rms.sustainedMs,
        cooldownRemainingMs: rms.cooldownRemainingMs,
        vadFloorDb: rms.vadFloorDb,
        inWarmup: rms.inWarmup,
      },
      stt: sttState(),
    };
  }

  // STT 状態のスナップショット。AzureSttProvider なら実状態、それ以外（Noop 等）は無効。
  function sttState(): SttRuntimeState {
    if (stt instanceof AzureSttProvider) {
      return stt.state();
    }
    return { enabled: false, lastText: "", labelHits: [], triggerCount: 0 };
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
    if (faceHealthTimer !== null) clearInterval(faceHealthTimer);
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
