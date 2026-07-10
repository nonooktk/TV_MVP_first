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
import { captureBurst, type BurstPhoto } from "./burst";
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
  CentroidTrigger,
  DEFAULT_CENTROID_PARAMS,
  type CentroidTriggerEvent,
} from "./centroidTrigger";
import {
  FaceTrigger,
  DEFAULT_FACE_TRIGGER_PARAMS,
  type FaceTriggerState,
} from "./faceTrigger";
import {
  saveAudio,
  savePhotos,
  type CaptureMetadata,
  type PhotoRecord,
} from "./storage";
import { VideoRing } from "./videoRing";
import { MeasurementLog, type MeasurementLogExport } from "./measurementLog";
import { flushMeasurementLog } from "./measurementLogStorage";

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

/**
 * 記録通知の2段階化（改良3）。
 *
 * - "started": **トリガー瞬間**に即時通知する（保存の完了を待たない）。
 *   UI はこれでバッジをフラッシュし「📸 思い出を記録中…」を出す。
 * - "completed": 保存完了（またはタイムアウトの部分保存）時に通知する（従来の内容）。
 *   UI はこれで「思い出を記録しました（N）」へ更新する。記録カウントは completed 基準。
 *
 * 8秒タイムアウトの部分保存でも completed の photoCount は実際に保存できた枚数に整合する。
 */
export type DetectionEvent =
  | {
      type: "started";
      reason: TriggerReason;
    }
  | {
      type: "completed";
      reason: TriggerReason;
      /** 保存した写真枚数（連写＋look-back）。部分保存時も実枚数。 */
      photoCount: number;
      /** 音声スニペットを保存できたか。 */
      hasAudio: boolean;
      /** 発火時の face_score。 */
      faceScore: number;
    };

/** 表情検知の稼働状態（バッジ表示用）。 */
export type FaceHealthState = "loading" | "failed" | "no_face" | "ok";

/**
 * family lane（家族側マイク・第2系統）の状態（デバッグパネル用・2026-07-10 追加）。
 * familyAudioTrack が渡されなかった通話では null（DetectionRuntimeState.family）。
 */
export interface FamilyLaneState {
  /** 直近サンプルの音圧（dB）。未サンプルは null。 */
  rmsDb: number | null;
  /** baseline（家族側レーン独立）。未確立は null。 */
  baselineDb: number | null;
  /** baseline 比の相対上昇量（dB）。 */
  riseDb: number | null;
  /** 基準モード（provisional=仮基準 / speech=発話基準）。elder レーンとは独立。 */
  mode: "provisional" | "speech";
  /** リアーム済み（再発火可能）か。 */
  armed: boolean;
  /** 直近の重心基準比（現在値 / 基準）。算出不能なら null。 */
  centroidRiseRatio: number | null;
}

export interface AttachDetectionOptions {
  /** Agora の生 MediaStream（video/audio トラックを含む）。 */
  stream: MediaStream;
  /** 通話ID（IndexedDB の保存キー）。 */
  callId: string;
  /**
   * 声トリガーの両側化（family lane）: 家族側ローカルマイクの生 MediaStreamTrack。
   * 渡された場合のみ第2の検知系統（family lane）を有効化する
   * （rmsTrigger/centroidTrigger/audioPipeline を高齢者側=elder レーンとは別インスタンスで持ち、
   * baseline・発話累計・ノイズフロア推定・ノイズゲート・リアームのすべてを独立に学習する）。
   * STT は付けない（高齢者側のみ）。写真連写は現状どおり高齢者側の video リングから行う
   * （両側連写は次フェーズ）。未指定（null/undefined）なら family lane は動かない。
   */
  familyAudioTrack?: MediaStreamTrack | null;
  /**
   * 顔検知の家族側化・両側連写（Phase 2）: 家族側ローカルカメラの生 MediaStreamTrack（孫が映る側）。
   * 渡された場合のみ、
   *   - facePipeline（MediaPipe・表情スコア）を **この家族側映像** に接続する
   *     （高齢者側リモート映像では顔検知しない。MediaPipe インスタンスは1つだけ＝負荷対策）。
   *   - 顔トリガー（reason="face"・trigger_source="family"）を有効化する。
   *   - family videoRing（家族側 look-back）を回し、発火時に高齢者側＋家族側の両方から連写する。
   * 未指定（null/undefined）なら顔検知・顔トリガー・家族側連写は動かない（elder 側の映像連写のみ）。
   */
  familyVideoTrack?: MediaStreamTrack | null;
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
  /** 計測ログ（読み取り専用オブザーバー）のエクスポート用 JSON を取得する。 */
  exportMeasurementLog: () => MeasurementLogExport;
  /** 計測ログをクリアする（「ログクリア」ボタン用）。 */
  clearMeasurementLog: () => void;
  /** 計測ログの現在の記録件数（デバッグパネルの小表示用）。 */
  measurementLogCounts: () => { samples: number; events: number };
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
    /** baseline 学習が凍結中か（rise ≥ しきい値で盛り上がりを取り込まない）。デバッグパネル用。 */
    frozen: boolean;
    /**
     * 現在モードの rise 閾値（dB）。provisional=+24dB／speech=+12dB（2026-07-07 モード依存化）。
     * デバッグパネルの「パラメータ現在値」表示用。
     */
    riseThresholdDb: number;
    /**
     * リアーム済み（再発火可能）か（2026-07-07 追加）。発火直後は false、
     * rise が現行閾値未満に一度戻ると true に復帰する。デバッグパネル用。
     */
    armed: boolean;
    /** 基準モード（provisional=仮基準 / speech=発話基準）。改良1。 */
    mode: "provisional" | "speech";
    /** 発話（ノイズ+8dB 以上）の累計時間（ms）。5秒で speech モードへ。改良1。 */
    speechAccumMs: number;
    /** 発話中央値（直近20秒・dB）。窓が空なら null。改良1。 */
    speechMedianDb: number | null;
    /** ノイズゲート（固定・2026-07-10 追加）のしきい値（dB）。支給初期値 -50。 */
    noiseGateDb: number;
    /** 現在フレームがノイズゲート未満（完全な無音）か。2026-07-10 追加。デバッグパネル用。 */
    gated: boolean;
  };
  /** スペクトル重心トリガー（改良2）の状態。デバッグパネル用。 */
  centroid: {
    /** 直近サンプルのスペクトル重心（Hz）。未サンプルは null。 */
    lastCentroidHz: number | null;
    /** 基準重心（発話中央値・Hz）。窓が空なら null。 */
    baselineHz: number | null;
    /** 直近の基準比（現在値 / 基準）。算出不能なら null。 */
    riseRatio: number | null;
    /** 上昇（基準比 ≥ しきい値）の持続累積（ms）。sustainMs に達すると発火する。 */
    sustainedMs: number;
    /**
     * リアーム済み（再発火可能）か（2026-07-07 追加）。発火直後は false、
     * 基準比が閾値未満に一度戻ると true に復帰する。デバッグパネル用。
     */
    armed: boolean;
  };
  /** STT（感情ワード検知）の状態。STT 無効時は enabled=false。 */
  stt: SttRuntimeState;
  /**
   * family lane（家族側マイク・第2系統・声トリガーの両側化）の状態。
   * familyAudioTrack が渡されなかった通話では null。デバッグパネル用。
   */
  family: FamilyLaneState | null;
  /**
   * 顔トリガー（家族側の表情スコア発火・Phase 2）の状態。
   * familyVideoTrack が渡されなかった通話（顔検知なし）では null。デバッグパネル用。
   * lastScore は facePipeline.score()（家族側）、threshold/sustainedMs/armed は faceTrigger の値。
   */
  faceTrigger: FaceTriggerState | null;
}

declare global {
  interface Window {
    __detection?: DetectionWindowHook;
  }
}

/**
 * 連写結果（BurstPhoto[]）を IndexedDB 保存レコードへ変換する純粋ヘルパ（両側連写・Phase 2）。
 *
 * 各コマの metadata に stream（"elder"/"family"）を付与し、face_score・rms_db/rms_rise は
 * コマ別採点値（無ければ baseMeta / fallbackFaceScore）を採る。DOM 非依存＝vitest で単体検証する
 * （両側連写の stream 付与・枚数の検証はこの純粋関数を対象にする）。
 *
 * @param callId 通話ID
 * @param photos captureBurst の結果（連写＋look-back）
 * @param baseMeta 発火共通の metadata（trigger_reason / trigger_source / stt など）
 * @param stream このバーストの取得元カメラ（"elder" or "family"）
 * @param fallbackFaceScore コマ別 face_score が無い場合の代替値
 *   （elder は 0＝顔検知しない／family は発火時点の facePipeline スコア）
 */
export function toPhotoRecords(
  callId: string,
  photos: BurstPhoto[],
  baseMeta: CaptureMetadata,
  stream: "elder" | "family",
  fallbackFaceScore: number
): Omit<PhotoRecord, "id">[] {
  return photos.map((ph) => ({
    callId,
    blob: ph.blob,
    capturedAt: new Date(ph.capturedAtMs).toISOString(),
    metadata: {
      ...baseMeta,
      stream,
      lookback: ph.lookback,
      face_score: ph.faceScore ?? fallbackFaceScore,
      rms_db: ph.rms?.rmsDb ?? baseMeta.rms_db,
      rms_rise: ph.rms?.rmsRise ?? baseMeta.rms_rise,
    },
  }));
}

/**
 * 検知を配線する。video/audio トラックから RMS・表情・look-back を回し、
 * 発火時に連写＋音声スニペットを IndexedDB へ保存する。
 */
export function attachDetection(opts: AttachDetectionOptions): DetectionHandle {
  const { stream, callId, onEvent, onFaceHealth } = opts;

  // 全系統（elder の rms/centroid/stt ＋ family の rms/centroid）で共有するクールダウン（連打防止）。
  // 各 RmsTrigger/CentroidTrigger インスタンスは内部クールダウン（rmsTrigger のみ）や
  // リアームを持つが、reason・source をまたいだ「どれか1つでも発火したら
  // SHARED_COOLDOWN_MS は他系統も含めて次を抑止する」という横断ルールはここ（handleTrigger）
  // の lastTriggerAtMs 1本で一元管理する（2026-07-10: family lane 追加に伴い elder 専用から
  // 全系統横断へ拡張。値そのものは DEFAULT_RMS_PARAMS.cooldownMs=8000ms のまま）。
  const SHARED_COOLDOWN_MS = DEFAULT_RMS_PARAMS.cooldownMs; // 8000ms
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

  // 顔検知の家族側化・両側連写（Phase 2）: 家族側ローカルカメラ（孫が映る側）の生トラック。
  const familyVideoTrack = opts.familyVideoTrack ?? null;

  // 検知用の隠し <video> を1つ作るヘルパ（look-back / 連写 / 表情推論の共通ソース）。
  // muted+playsInline+autoplay で autoplay 制約を回避する。play() は失敗し得る
  // （autoplay ポリシー・トラック未確立）ため、loadedmetadata / canplay を機に再試行し、
  // 失敗はログに残す（無限「起動中」の一因＝映像フレーム未到達を観測可能にする）。
  const makeHiddenVideo = (track: MediaStreamTrack, label: string): HTMLVideoElement => {
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.autoplay = true;
    el.srcObject = new MediaStream([track]);
    const tryPlay = (): void => {
      const pr = el.play();
      if (pr && typeof pr.catch === "function") {
        pr.catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(`[detection] 検知用 video(${label}) の再生開始に失敗（再試行する）`, e);
        });
      }
    };
    // 初回 + メタデータ到達 + 再生可能になった各タイミングで再生を試みる。
    tryPlay();
    el.addEventListener("loadedmetadata", tryPlay);
    el.addEventListener("canplay", tryPlay);
    return el;
  };

  // 高齢者側リモート映像（elder look-back / elder 連写のソース）。表情検知はしない（家族側化）。
  const video = videoTrack ? makeHiddenVideo(videoTrack, "elder") : document.createElement("video");
  // 家族側ローカルカメラ映像（facePipeline〈表情スコア／顔トリガー〉＋ family look-back / family 連写のソース）。
  const familyVideo = familyVideoTrack ? makeHiddenVideo(familyVideoTrack, "family") : null;

  const rmsTrigger = new RmsTrigger();
  // スペクトル重心トリガー（改良2）。発話フレームのみ push する（下の onCentroid でゲート）。
  const centroidTrigger = new CentroidTrigger();
  // 計測ログ（読み取り専用オブザーバー）。検知本体には一切書き込まない。
  // トリガーパラメータ設計の実地テスト用に、1秒ごとのサマリ（ピークホールド込み）と
  // 全発火イベントの詳細を蓄積し、デバッグパネルの「計測ログDL」からエクスポートする。
  const measurementLog = new MeasurementLog(callId, {
    rms: DEFAULT_RMS_PARAMS,
    centroid: DEFAULT_CENTROID_PARAMS,
  });
  // elder（高齢者側）の look-back リング。両側連写の高齢者側ソース。
  const videoRing = videoTrack ? new VideoRing(video) : null;
  // family（家族側）の look-back リング（両側連写・Phase 2）。家族側カメラがある場合のみ。
  const familyVideoRing = familyVideo ? new VideoRing(familyVideo) : null;
  // 顔検知の家族側化（Phase 2）: MediaPipe は **家族側映像** に接続する（1インスタンスのみ）。
  const facePipeline = familyVideo ? new FacePipeline(familyVideo) : null;
  // 顔トリガー（家族側の表情スコア発火・Phase 2）。facePipeline がある場合のみ。
  const faceTrigger = facePipeline ? new FaceTrigger() : null;
  const audioPipeline = audioTrack
    ? new AudioPipeline(
        audioTrack,
        (db, now) => onRms(db, now),
        {},
        // 家族側 VAD 床の自動化（item 12）: ノイズフロア推定 → 床=ノイズ+8dB を rmsTrigger へ反映。
        (vadFloorDb) => rmsTrigger.setVadFloorDb(vadFloorDb),
        // スペクトル重心（改良2）: 発話フレームのみ centroidTrigger へ渡す。
        (centroidHz, now) => onCentroid(centroidHz, now),
        // 発話ゲート用のノイズフロア推定（改良1）を rmsTrigger と onCentroid ゲートへ反映する。
        (noiseFloorDb) => {
          lastNoiseFloorDb = noiseFloorDb;
          rmsTrigger.setNoiseFloorDb(noiseFloorDb);
        }
      )
    : null;
  // onCentroid の発話ゲートで使う「直近の音圧(dB)」と「ノイズフロア」を保持する。
  let lastRmsDb: number | null = null;
  let lastNoiseFloorDb: number | null = null;
  // 直近フレームがノイズゲート（固定 -50dB）未満だったか（elder レーン）。
  // ノイズゲート未満のフレームは重心トリガーへも isSpeech=false で渡す（持続リセット）。
  let lastGatedElder = false;

  // --- family lane（家族側ローカルマイク・声トリガーの両側化・2026-07-10 追加） ---
  // elder レーン（高齢者側リモート音声）とは完全に独立したインスタンス（baseline・
  // 発話累計・ノイズフロア推定・ノイズゲート・リアームのいずれも別系統で学習する）。
  // familyAudioTrack が渡されなかった場合は null のままで、family lane 一式は動かない
  // （best-effort。無くても elder レーンの検知は従来どおり動作する）。
  const familyRmsTrigger = opts.familyAudioTrack ? new RmsTrigger() : null;
  const familyCentroidTrigger = opts.familyAudioTrack ? new CentroidTrigger() : null;
  let lastFamilyRmsDb: number | null = null;
  let lastFamilyNoiseFloorDb: number | null = null;
  let lastFamilyGated = false;
  const familyAudioPipeline =
    opts.familyAudioTrack && familyRmsTrigger && familyCentroidTrigger
      ? new AudioPipeline(
          opts.familyAudioTrack,
          (db, now) => onFamilyRms(db, now),
          {},
          (vadFloorDb) => familyRmsTrigger.setVadFloorDb(vadFloorDb),
          (centroidHz, now) => onFamilyCentroid(centroidHz, now),
          (noiseFloorDb) => {
            lastFamilyNoiseFloorDb = noiseFloorDb;
            familyRmsTrigger.setNoiseFloorDb(noiseFloorDb);
          }
        )
      : null;

  let running = true;
  let triggerCount = 0;
  let busy = false; // 発火処理中の再入防止（elder/family 両レーンで共有。同時キャプチャを避ける）

  // --- 発火処理（実発火と forceTrigger の共通経路） --------------------------
  // reasonOverride を渡すと ev の reason より優先する（STT 発火は ev=null＋"stt"／
  // 重心発火は ev=null＋"centroid"＋centroidEv）。
  // source は発火元（声トリガーの両側化・2026-07-10 追加）。既定 "elder"。
  // "family" のときは family lane 側の RmsTrigger/CentroidTrigger のスナップショットを
  // 計測ログ・metadata へ使う（elder 側の状態を誤って記録しないため）。
  async function handleTrigger(
    ev: RmsTriggerEvent | null,
    reasonOverride?: TriggerReason,
    centroidEv?: CentroidTriggerEvent,
    source: "elder" | "family" = "elder"
  ): Promise<void> {
    if (!running || busy) return;
    const triggerAtMs = Date.now();
    // 共有クールダウン: 直近発火から SHARED_COOLDOWN_MS 未満は抑止
    // （RMS/STT/重心/顔・elder/family 連打防止）。
    // forceTrigger（テスト）は reasonOverride=undefined & ev=null で来るため抑止しない。
    const isRealTrigger =
      reasonOverride === "stt" ||
      reasonOverride === "centroid" ||
      reasonOverride === "face" ||
      ev !== null;
    if (
      isRealTrigger &&
      !passesSharedCooldown(triggerAtMs, lastTriggerAtMs, SHARED_COOLDOWN_MS)
    ) {
      return;
    }
    busy = true;
    lastTriggerAtMs = triggerAtMs;
    const reason: TriggerReason = reasonOverride ?? ev?.reason ?? "rms";

    // 発火元レーンの RmsTrigger/CentroidTrigger（声トリガーの両側化・2026-07-10 追加）。
    // source="family" かつ family lane が有効な場合のみ family 側インスタンスを使う。
    // それ以外（elder・または family lane 未接続）は従来どおり elder 側インスタンスを使う。
    const activeRmsTrigger =
      source === "family" && familyRmsTrigger ? familyRmsTrigger : rmsTrigger;
    const activeCentroidTrigger =
      source === "family" && familyCentroidTrigger ? familyCentroidTrigger : centroidTrigger;

    // 【記録通知の2段階化（改良3）】トリガー瞬間に即時通知する（保存の完了を待たない）。
    // UI はこれでバッジをフラッシュし「思い出を記録中…」を出す。
    onEvent?.({ type: "started", reason });

    // 計測ログ（読み取り専用オブザーバー）: 発火瞬間の全スナップショットを記録する。
    // 完了情報（photo_count・partial_save）は後段の salvage/finally 後に埋める。
    // source（trigger_source）も併せて記録する（声トリガーの両側化・2026-07-10 追加）。
    measurementLog.recordTriggerStart(
      reason,
      activeRmsTrigger.snapshot(triggerAtMs),
      activeCentroidTrigger.snapshot(),
      currentAutoGainDb(),
      triggerAtMs,
      source
    );

    const capturedAt = new Date(triggerAtMs).toISOString();
    // 表情・STT は elder（高齢者側の映像・音声）のみに紐づく。family lane 発火でも同じ値を使う
    // （表情・STT は撮影対象=高齢者側から得るため、発火元レーンによらず共通）。
    const faceScore = facePipeline?.score() ?? 0;
    const faceTop = facePipeline?.topBlendshapes() ?? [];
    const sttResult = stt.latest();
    // 重心（改良2）は発火時点のサンプルを全写真 metadata に付ける。
    // 重心発火なら発火イベント値、それ以外の発火でも発火元レーンの直近サンプルを添える。
    const centroidSample = activeCentroidTrigger.sample();
    const spectralCentroid = centroidEv?.centroidHz ?? centroidSample.centroidHz ?? undefined;
    const centroidRiseRatio =
      centroidEv?.riseRatio ?? centroidSample.riseRatio ?? undefined;

    // metadata 共通部（data-contract.md 付録キー＋重心 spectral_centroid / centroid_rise_ratio）。
    // face_score は各コマ固有（下の map で上書き）なので base には発火時点値を入れる。
    // trigger_source（声トリガーの両側化・2026-07-10 追加）は発火元レーンをそのまま記録する。
    const baseMeta: CaptureMetadata = {
      rms_db: ev?.rmsDb,
      rms_rise: ev?.rmsRise,
      face_score: faceScore,
      trigger_reason: reason,
      trigger_source: source,
      blendshapes_top: faceTop.length > 0 ? faceTop : undefined,
      stt_text: sttResult?.text,
      stt_labels: sttResult?.labels,
      spectral_centroid: spectralCentroid,
      centroid_rise_ratio: centroidRiseRatio,
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
      // 1) 両側連写＋look-back（両側連写・Phase 2）。どの発火でも高齢者側＋家族側の両方から
      //    10枚ずつ（＋各 look-back）撮る。face_score も rms_db/rms_rise（音圧）も「発火瞬間の
      //    1値共有」ではなく **各ショット時点** を採点する（burst の sampleFaceScore / sampleRms）。
      //    look-back コマは撮影が過去のため発火時点の直近値を共有する。
      //    - 高齢者側（elder）: face_score=0（顔検知は家族側のみ＝負荷対策）。音圧のコマ別採点で
      //      無表情でも連写内に自然な差がつき、候補が全員同点になるのを防ぐ（stage1 は per-photo
      //      の rms_rise を使う）。
      //    - 家族側（family）: 家族側 facePipeline のコマ別 face_score を付与する。
      //    2バーストは並列に走らせて所要時間を抑える（別 canvas・干渉しない。CAPTURE_TIMEOUT_MS
      //    内に収める）。
      prog.stage = "burst";
      const elderLookback = videoRing?.snapshot() ?? [];
      const familyLookback = familyVideoRing?.snapshot() ?? [];
      const triggerRms = { rmsDb: ev?.rmsDb, rmsRise: ev?.rmsRise };

      // 発火元レーンによらず、コマ別音圧は各ストリームに対応するレーンの直近値を採る
      // （family 写真には family lane の音圧、elder 写真には elder レーンの音圧）。
      const sampleRmsFrom = (t: RmsTrigger) => () => {
        const s = t.sample();
        // null（未サンプル）は metadata に載せない＝undefined へ変換する。
        return {
          rmsDb: s.rmsDb ?? undefined,
          rmsRise: s.rmsDb === null ? undefined : s.rmsRise,
        };
      };

      const elderBurst = videoTrack
        ? captureBurst(video, elderLookback, {}, {
            // 高齢者側は顔検知しない＝face_score は常に 0。
            sampleFaceScore: () => 0,
            lookbackFaceScore: 0,
            sampleRms: sampleRmsFrom(rmsTrigger),
            lookbackRms: triggerRms,
          })
        : Promise.resolve([]);

      const familyBurst = familyVideo
        ? captureBurst(familyVideo, familyLookback, {}, {
            // 家族側は facePipeline のコマ別 face_score を付与する。
            sampleFaceScore: () => facePipeline?.score() ?? 0,
            lookbackFaceScore: faceScore,
            sampleRms: sampleRmsFrom(familyRmsTrigger ?? rmsTrigger),
            lookbackRms: triggerRms,
          })
        : Promise.resolve([]);

      const [elderPhotos, familyPhotos] = await Promise.all([elderBurst, familyBurst]);

      // 写真レコードを組み立てて退避（後段でタイムアウトしても salvage で保存を試みる）。
      // stream・lookback・face_score・rms_db/rms_rise は各コマ由来（コマごと採点）。
      // 各値が無い場合（sample* 未指定経路）は発火時点値=baseMeta へフォールバックする。
      prog.capturedPhotos = [
        ...toPhotoRecords(callId, elderPhotos, baseMeta, "elder", 0),
        ...toPhotoRecords(callId, familyPhotos, baseMeta, "family", faceScore),
      ];

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

    // タイムアウト／例外（部分保存＝salvage 経由）だったかを計測ログの partial_save に渡す。
    let partialSave = false;
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
        partialSave = true;
        await salvage();
      } else if (outcome === "error") {
        // capture 内の予期しない例外。撮れたぶんの保存を試みる（busy は finally で必ず解除）。
        // eslint-disable-next-line no-console
        console.warn(
          `[detection] 発火キャプチャで例外（段階=${prog.stage}）。撮れたぶんを保存する`
        );
        partialSave = true;
        await salvage();
      }
    } finally {
      busy = false;
    }

    // 部分成果でも保存できていれば発火として通知・カウントする（改良3・completed）。
    // 8秒タイムアウトの部分保存でも photoCount は実際に保存できた枚数（prog.photoCount）に整合する。
    if (prog.savedPhotos || prog.savedAudio) {
      triggerCount += 1;
      // 計測ログ（読み取り専用オブザーバー）: 発火イベントへ完了情報を埋める。
      measurementLog.recordTriggerComplete(prog.photoCount, partialSave);
      onEvent?.({
        type: "completed",
        reason,
        photoCount: prog.photoCount,
        hasAudio: prog.savedAudio,
        faceScore,
      });
    } else {
      // 何も保存できなかった（発火はしたが写真も音声も0件）場合も、
      // photo_count=0・partial_save=true として完了させておく（未確定のまま残さない）。
      measurementLog.recordTriggerComplete(0, true);
    }
  }

  // --- RMS サンプル → 発火判定（elder レーン） -------------------------------
  function onRms(rmsDb: number, nowMs: number): void {
    if (!running) return;
    lastRmsDb = rmsDb; // onCentroid の発話ゲート判定に使う。
    const ev = rmsTrigger.push(rmsDb, nowMs);
    // 計測ログ（読み取り専用オブザーバー）: このフレームの rise・ゲート状態を観測する
    // （push 後の sample() は push が動かした内部状態の「結果」を読むだけで書き込まない）。
    const s = rmsTrigger.sample();
    lastGatedElder = s.gated; // ノイズゲート未満なら onCentroid へも isSpeech=false で伝える。
    measurementObserveRms(s.rmsRise, s.gated, nowMs);
    if (ev) {
      void handleTrigger(ev);
    }
  }

  // --- スペクトル重心サンプル → 発火判定（改良2・2026-07-07 厳密化・elder レーン）---
  // 発話ゲート成立可否（rmsDb ≥ ノイズフロア +SPEECH_GATE_DB・かつノイズゲート以上）を
  // 毎フレーム centroidTrigger へ渡す。非発話フレームは centroidTrigger 内部で基準を
  // 動かさず持続カウントをリセットする（無言時の発火排除の厳密化）。ノイズゲート未満の
  // フレームは isSpeech=false として渡す（2026-07-10 追加＝完全な無音として扱う）。
  // 基準比 +30% を 200ms 持続**かつ発話ゲート成立**で reason="centroid" を発火する。
  // 発火は handleTrigger 経由で全系統横断の共有クールダウン（8秒）が適用される。
  function onCentroid(centroidHz: number, nowMs: number): void {
    if (!running) return;
    // 発話ゲート: ノイズフロア未推定の間・ノイズゲート未満の間は発話判定できないため
    // 非発話扱い（持続は積まない）。
    const isSpeech =
      !lastGatedElder &&
      lastRmsDb !== null &&
      lastNoiseFloorDb !== null &&
      lastRmsDb >= lastNoiseFloorDb + DEFAULT_RMS_PARAMS.speechGateDb;
    const ev = centroidTrigger.push(centroidHz, isSpeech, nowMs);
    // 計測ログ（読み取り専用オブザーバー）: このフレームの発話判定・重心比を観測する。
    const cs = centroidTrigger.sample();
    measurementObserveCentroid(isSpeech, cs.riseRatio, lastGatedElder, nowMs);
    if (ev) {
      void handleTrigger(null, "centroid", ev);
    }
  }

  // --- RMS サンプル → 発火判定（family lane・声トリガーの両側化・2026-07-10 追加） ---
  // elder レーンと同じロジック（RmsTrigger.push）だが、familyRmsTrigger は完全に別インスタンス
  // なので baseline・sustain・ノイズゲート・リアームは elder レーンに一切影響しない。
  // 発火時は source="family" で handleTrigger を呼ぶ（全系統共有クールダウンは
  // handleTrigger 内の lastTriggerAtMs 1本で elder と横断的に適用される）。
  function onFamilyRms(rmsDb: number, nowMs: number): void {
    if (!running || !familyRmsTrigger) return;
    lastFamilyRmsDb = rmsDb;
    const ev = familyRmsTrigger.push(rmsDb, nowMs);
    const s = familyRmsTrigger.sample();
    lastFamilyGated = s.gated;
    measurementObserveFamilyRms(s.rmsRise, nowMs);
    if (ev) {
      void handleTrigger(ev, undefined, undefined, "family");
    }
  }

  // --- スペクトル重心サンプル → 発火判定（family lane・2026-07-10 追加） -----
  // elder レーンの onCentroid と同型のロジックだが、family 自身の rms/ノイズフロア/
  // ノイズゲート状態（lastFamilyRmsDb/lastFamilyNoiseFloorDb/lastFamilyGated）のみを参照する。
  function onFamilyCentroid(centroidHz: number, nowMs: number): void {
    if (!running || !familyCentroidTrigger) return;
    const isSpeech =
      !lastFamilyGated &&
      lastFamilyRmsDb !== null &&
      lastFamilyNoiseFloorDb !== null &&
      lastFamilyRmsDb >= lastFamilyNoiseFloorDb + DEFAULT_RMS_PARAMS.speechGateDb;
    const ev = familyCentroidTrigger.push(centroidHz, isSpeech, nowMs);
    const cs = familyCentroidTrigger.sample();
    measurementObserveFamilyCentroid(cs.riseRatio, nowMs);
    if (ev) {
      void handleTrigger(null, "centroid", ev, "family");
    }
  }

  // --- 計測ログのフレーム観測（読み取り専用オブザーバー）--------------------
  // RMS と重心は別々のコールバック（onRms/onCentroid）から呼ばれるが、同じ measurementLog
  // の1フレーム分の観測として合算する（frame ごとに部分的な値を渡し、observeFrame 内で
  // 各フィールドを個別にピークホールドする）。
  function measurementObserveRms(riseDb: number, gated: boolean, nowMs: number): void {
    measurementLog.observeFrame({ riseDb, isSpeech: false, centroidRatio: null, gated }, nowMs);
    maybeTickMeasurementLog(nowMs);
  }
  function measurementObserveCentroid(
    isSpeech: boolean,
    centroidRatio: number | null,
    gated: boolean,
    nowMs: number
  ): void {
    measurementLog.observeFrame({ riseDb: null, isSpeech, centroidRatio, gated }, nowMs);
    maybeTickMeasurementLog(nowMs);
  }
  // family lane（家族側マイク）専用の観測（family_rise_peak_db / family_centroid_ratio_peak）。
  function measurementObserveFamilyRms(riseDb: number, nowMs: number): void {
    measurementLog.observeFamilyFrame({ riseDb, centroidRatio: null }, nowMs);
    maybeTickMeasurementLog(nowMs);
  }
  function measurementObserveFamilyCentroid(
    centroidRatio: number | null,
    nowMs: number
  ): void {
    measurementLog.observeFamilyFrame({ riseDb: null, centroidRatio }, nowMs);
    maybeTickMeasurementLog(nowMs);
  }

  // 1秒間隔でサマリサンプルを確定する（MeasurementLog.tick が内部で間引くため、
  // RMS/重心いずれかのフレームが来るたびに呼んでよい）。「現在値」フィールドは
  // 従来どおり elder レーンの snapshot を使う（family lane は peak フィールドのみ）。
  function maybeTickMeasurementLog(nowMs: number): void {
    measurementLog.tick(
      {
        rms: rmsTrigger.snapshot(nowMs),
        centroid: centroidTrigger.snapshot(),
        noiseFloorDb: lastNoiseFloorDb,
        autoGainDb: currentAutoGainDb(),
      },
      nowMs
    );
  }

  // 自ゲイン現在値（dB）。取得できる場合のみ（家族側 window.__autoGainFamily）。
  function currentAutoGainDb(): number | null {
    if (typeof window === "undefined") return null;
    const g = window.__autoGainFamily;
    return g?.enabled ? g.gainDb : null;
  }

  // --- 起動 -----------------------------------------------------------------
  videoRing?.start();
  familyVideoRing?.start(); // family（家族側）look-back リング（両側連写・Phase 2）。未接続なら null。
  void facePipeline?.start(); // ロード失敗しても throw しない（best-effort）

  // --- 顔トリガー（家族側の表情スコア発火・Phase 2）のポーリング ---------------
  // facePipeline.score()（家族側の表情スコア）を約 sampleIntervalMs 間隔で読み、faceTrigger へ
  // 投入する。絶対閾値 0.7 を 300ms 持続で reason="face"・trigger_source="family" 発火する
  // （全系統共有クールダウン8秒は handleTrigger 側で横断適用される）。計測ログには
  // face_score のこの1秒間のピーク（face_score_peak）を観測させる。
  const faceTriggerTimer: ReturnType<typeof setInterval> | null =
    facePipeline && faceTrigger
      ? setInterval(() => {
          if (!running) return;
          const score = facePipeline.score();
          measurementLog.observeFaceFrame(score, Date.now());
          const ev = faceTrigger.push(score, Date.now());
          if (ev) {
            void handleTrigger(null, "face", undefined, "family");
          }
        }, DEFAULT_FACE_TRIGGER_PARAMS.sampleIntervalMs)
      : null;
  // STT は音声トラックがある場合のみ起動（best-effort・失敗しても通話継続）。
  // 声トリガーの両側化（2026-07-10）: STT は高齢者側（elder）のみ。family lane には付けない。
  if (audioTrack) {
    void stt.start(audioTrack).catch(() => {});
  }
  audioPipeline?.start();
  familyAudioPipeline?.start(); // family lane（家族側マイク）。未接続なら null で何もしない。

  // --- 計測ログの永続化（通話終了後の回収導線・2026-07-08 追加） -----------
  // タブクラッシュ・切り忘れ対策として、通話中は約10秒ごとに IndexedDB へ
  // 完全スナップショット（toExport()）を upsert する（差分追記ではない。
  // measurementLogStorage.ts の設計判断コメント参照）。
  // 検知本体（onRms/onCentroid/handleTrigger）には一切干渉しない、
  // 永続化専用の追加タイマー（読み取り専用オブザーバーである measurementLog の
  // 現在状態を読むだけ）。失敗しても検知・通話は止めない（best-effort）。
  const MEASUREMENT_FLUSH_INTERVAL_MS = 10000;
  const measurementFlushTimer: ReturnType<typeof setInterval> = setInterval(() => {
    flushMeasurementLog(measurementLog.toExport()).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.warn("[detection] 計測ログの定期フラッシュに失敗（記録は継続）", e);
    });
  }, MEASUREMENT_FLUSH_INTERVAL_MS);

  // --- 表情検知の稼働状態ポーリング（バッジ用） -----------------------------
  // 約1秒間隔で face の health を見て、状態が変わったら onFaceHealth へ通知する。
  let lastFaceHealth: FaceHealthState | null = null;
  const FACE_HEALTH_POLL_MS = 1000;
  const faceHealthTimer: ReturnType<typeof setInterval> | null =
    onFaceHealth && facePipeline
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
        frozen: rms.frozen,
        riseThresholdDb: rms.riseThresholdDb,
        armed: rms.armed,
        mode: rms.mode,
        speechAccumMs: rms.speechAccumMs,
        speechMedianDb: rms.speechMedianDb,
        noiseGateDb: rms.noiseGateDb,
        gated: rms.gated,
      },
      centroid: (() => {
        const c = centroidTrigger.snapshot();
        return {
          lastCentroidHz: c.lastCentroidHz,
          baselineHz: c.baselineHz,
          riseRatio: c.riseRatio,
          sustainedMs: c.sustainedMs,
          armed: c.armed,
        };
      })(),
      stt: sttState(),
      family:
        familyRmsTrigger && familyCentroidTrigger
          ? (() => {
              const r = familyRmsTrigger.snapshot(Date.now());
              const c = familyCentroidTrigger.snapshot();
              return {
                rmsDb: r.lastRmsDb,
                baselineDb: r.baselineDb,
                riseDb: r.riseDb,
                mode: r.mode,
                armed: r.armed,
                centroidRiseRatio: c.riseRatio,
              };
            })()
          : null,
      faceTrigger: faceTrigger
        ? (() => {
            const s = faceTrigger.snapshot();
            // lastScore は facePipeline の現在スコアを優先（faceTrigger は前回 push 値を保持）。
            return { ...s, lastScore: facePipeline?.score() ?? s.lastScore };
          })()
        : null,
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
    if (faceTriggerTimer !== null) clearInterval(faceTriggerTimer);
    clearInterval(measurementFlushTimer);
    videoRing?.stop();
    familyVideoRing?.stop(); // family（家族側）look-back リング（両側連写・Phase 2）。
    facePipeline?.stop();
    audioPipeline?.stop();
    familyAudioPipeline?.stop(); // family lane（家族側マイク）。未接続なら null で何もしない。
    void stt.stop().catch(() => {});
    try {
      video.pause();
      video.srcObject = null;
      if (familyVideo) {
        familyVideo.pause();
        familyVideo.srcObject = null;
      }
    } catch {
      /* noop */
    }
    // 通話終了時の確定フラッシュ（2026-07-08 追加）: 10秒間隔の定期フラッシュを待たず、
    // detach 時点の最終状態をもう一度 upsert する（取りこぼし防止のダメ押し。
    // best-effort・失敗しても detach 自体は中断しない）。
    flushMeasurementLog(measurementLog.toExport()).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.warn("[detection] 計測ログの終了時確定フラッシュに失敗", e);
    });
    if (typeof window !== "undefined" && window.__detection) {
      // state は残す価値があるが、参照が消えるよう running=false のスナップショットに固定。
      const frozen = currentState();
      window.__detection = {
        forceTrigger: async () => {},
        state: frozen,
      };
    }
  }

  return {
    detach,
    exportMeasurementLog: () => measurementLog.toExport(),
    clearMeasurementLog: () => measurementLog.clear(),
    measurementLogCounts: () => measurementLog.counts(),
  };
}

export type { CaptureMetadata } from "./storage";
export type { MeasurementLogExport, MeasurementSample, MeasurementTriggerEvent } from "./measurementLog";
