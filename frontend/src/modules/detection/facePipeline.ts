// 委託コア②（検知キャプチャ）: MediaPipe FaceLandmarker による表情スコア算出
//
// @mediapipe/tasks-vision の FaceLandmarker で相手映像から face_score を約200ms間隔で
// 算出する。face_score は mouthSmile 系 blendshape 中心の 0〜1。
//
// 【アセット配信 — CDN 優先＋ローカル fallback（2026-07-05 修正）】
//   当初は WASM/モデルを public/mediapipe/ にコピーしてローカル配信していたが、
//   本番（Azure Static Web Apps Free）は 9.4MB の WASM・3.7MB のモデルといった
//   大容量静的アセットの配信を ~40〜70KB/s に強く throttle するため、これらが
//   起動タイムアウト（10s）内にダウンロードできず「表情検知が停止中」になった
//   （ローカル dev はディスク即時配信のため loadMs≈200ms で成功＝本番でのみ再現）。
//   実測: 同一 9.4MB WASM が SWA では 30s で 1〜2MB しか届かず停止する一方、
//   jsDelivr CDN では 1.16s（8MB/s）で完走する（byte-identical・version pin 済み）。
//   → **CDN を優先し、失敗時のみローカル /mediapipe/ へ fallback** する。
//     - WASM:  jsDelivr（@mediapipe/tasks-vision@<pin>/wasm）→ /mediapipe/wasm
//     - モデル: Google Storage（float16 公開モデル）→ /mediapipe/models/face_landmarker.task
//   モデル資産は Google 公開の非PIIファイルであり、CDN 依存は表情検知アセットに限る
//   （通話中の顔・音声データは従来どおりクラウドへ出さない＝設計は不変）。
//   コピー手順・再取得は modules/detection/README.md 参照。
//
// 【耐障害性】ロード失敗時は face_score=0 で継続する（検知全体を止めない）。
//
// SSR 回避のため @mediapipe/tasks-vision は dynamic import する。

// tasks-vision の pin バージョン（package.json と一致させること）。CDN URL の版に使う。
const TASKS_VISION_VERSION = "0.10.14";

// CDN 配信元（本番の SWA throttle 回避のため優先）。
const CDN_WASM_PATH = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const CDN_MODEL_PATH =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// ローカル配信（fallback）。CDN 到達不可（オフライン・CDN 障害）時に使う。
const LOCAL_WASM_PATH = "/mediapipe/wasm";
const LOCAL_MODEL_PATH = "/mediapipe/models/face_landmarker.task";

/** face 検出の設定。 */
export interface FacePipelineParams {
  /** 推論間隔（ms）。 */
  intervalMs: number;
  /** face_score に採用する blendshape 名（部分一致・小文字比較）。mouthSmile 中心。 */
  smileBlendshapes: string[];
}

export const DEFAULT_FACE_PARAMS: FacePipelineParams = {
  intervalMs: 200,
  smileBlendshapes: ["mouthsmileleft", "mouthsmileright"],
};

/**
 * 相手映像の表情スコアを継続算出するパイプライン。
 * start() でロード＆推論ループ開始、score() で直近の face_score（0〜1）を取得する。
 * ロードに失敗しても throw せず、score() は 0 を返し続ける（best-effort）。
 */
export class FacePipeline {
  private readonly video: HTMLVideoElement;
  private readonly p: FacePipelineParams;
  private landmarker: unknown | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScore = 0;
  private lastTop: string[] = [];
  private loaded = false;
  private failed = false;
  private loadMs = 0;
  // ロードに成功したアセット配信元（観測・ログ用）。"cdn" | "local" | null（未ロード）。
  private assetSource: "cdn" | "local" | null = null;
  // 失敗理由（health.reason・バッジのツールチップ／ログ用）。
  private failReason: string | null = null;
  // start() を呼んだ時刻（epoch ms）。起動タイムアウトの基準。
  private startedAtMs = 0;
  // 起動タイムアウト（loading のまま固まらないための終端保証）。
  private startTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  // --- 稼働可視化（health）用のカウンタ -------------------------------------
  private inferCount = 0; // detectForVideo を呼んだ回数
  private faceSeenCount = 0; // 顔（blendshape）を検出できた回数
  private inferErrorCount = 0; // 推論が例外で落ちた回数
  private lastFaceAtMs = 0; // 最後に顔を検出できた時刻（epoch ms）

  constructor(video: HTMLVideoElement, params: Partial<FacePipelineParams> = {}) {
    this.video = video;
    this.p = { ...DEFAULT_FACE_PARAMS, ...params };
  }

  /** モデルをロードして推論ループを開始する。失敗しても例外は投げない。 */
  async start(): Promise<void> {
    this.startedAtMs = Date.now();

    // --- 起動タイムアウト（loading 固定の終端保証） --------------------------
    // MediaPipe のロードがハングする（WASM/モデルの取得が本番配信で無応答）と、
    // loaded も failed も立たず health が "loading" のまま永久に固まる。
    // START_TIMEOUT_MS 経過しても稼働（ロード完了かつ最低1回の推論到達）に
    // 至らないなら failed（理由付き）へ落とし、バッジを「停止中」にする。
    this.startTimeoutTimer = setTimeout(() => {
      this.startTimeoutTimer = null;
      if (this.failed) return; // 既にロード失敗で failed 済み
      if (!this.loaded) {
        // ロードが START_TIMEOUT_MS 以内に完了しなかった（配信ハング等）。
        this.failed = true;
        this.failReason = `モデルのロードが${Math.round(
          START_TIMEOUT_MS / 1000
        )}秒以内に完了しませんでした（アセット配信の失敗の可能性）`;
        // eslint-disable-next-line no-console
        console.warn(`[detection] 表情検知の起動タイムアウト: ${this.failReason}`);
      } else if (this.inferCount === 0) {
        // ロードは済んだが推論ループが一度も実フレームに到達していない
        // （video が videoWidth=0 のまま＝再生開始できていない）。
        this.failed = true;
        this.failReason = `映像フレームが${Math.round(
          START_TIMEOUT_MS / 1000
        )}秒間到達しませんでした（相手映像が再生されていない可能性）`;
        // eslint-disable-next-line no-console
        console.warn(`[detection] 表情検知の起動タイムアウト: ${this.failReason}`);
      }
    }, START_TIMEOUT_MS);

    const t0 =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      const vision = await import("@mediapipe/tasks-vision");
      const { FilesetResolver, FaceLandmarker } = vision;

      // CDN 優先でロードし、失敗したらローカル配信へ fallback する。
      // 本番（SWA）は大容量アセットを throttle するため CDN が成功の本命。
      // CDN も不可（オフライン等）の場合のみローカルにフォールバックする。
      const buildLandmarker = async (
        wasmBase: string,
        modelUrl: string
      ): Promise<unknown> => {
        const fileset = await FilesetResolver.forVisionTasks(wasmBase);
        return FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelUrl },
          outputFaceBlendshapes: true,
          runningMode: "VIDEO",
          numFaces: 1,
        });
      };

      try {
        this.landmarker = await buildLandmarker(CDN_WASM_PATH, CDN_MODEL_PATH);
        this.assetSource = "cdn";
      } catch (cdnErr) {
        // CDN 失敗（ネットワーク・CDN 障害）→ ローカル配信へ fallback。
        // eslint-disable-next-line no-console
        console.warn(
          "[detection] MediaPipe を CDN からロードできませんでした。ローカル配信へフォールバックします。",
          cdnErr
        );
        this.landmarker = await buildLandmarker(LOCAL_WASM_PATH, LOCAL_MODEL_PATH);
        this.assetSource = "local";
      }

      this.loaded = true;
      this.loadMs =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
      // eslint-disable-next-line no-console
      console.info(
        `[detection] MediaPipe FaceLandmarker ロード成功（source=${this.assetSource} loadMs=${Math.round(
          this.loadMs
        )}）`
      );
    } catch (e) {
      // CDN・ローカルの両方で失敗（アセット未配置・WASM非対応・両系統とも到達不可など）は
      // 検知全体を止めず face_score=0 で継続。起動タイムアウトを待たず即 failed（理由付き）に
      // する＝バッジが早く「停止中」に遷移する。
      this.failed = true;
      this.failReason =
        "モデルのロードに失敗しました（CDN・ローカル配信の両方に到達できませんでした）";
      if (this.startTimeoutTimer !== null) {
        clearTimeout(this.startTimeoutTimer);
        this.startTimeoutTimer = null;
      }
      // eslint-disable-next-line no-console
      console.warn("[detection] FaceLandmarker のロードに失敗（face_score=0 で継続）", e);
      return;
    }

    this.timer = setInterval(() => this.infer(), this.p.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startTimeoutTimer !== null) {
      clearTimeout(this.startTimeoutTimer);
      this.startTimeoutTimer = null;
    }
    const lm = this.landmarker as { close?: () => void } | null;
    lm?.close?.();
    this.landmarker = null;
  }

  /** 直近の face_score（0〜1）。ロード失敗時・未推論時は 0。 */
  score(): number {
    return this.lastScore;
  }

  /** 直近の上位 blendshape 名（metadata.blendshapes_top 用）。 */
  topBlendshapes(): string[] {
    return [...this.lastTop];
  }

  /** ロード状態（観測用）。loadMs は成功時のロード所要時間（ms）。source は配信元。 */
  status(): {
    loaded: boolean;
    failed: boolean;
    loadMs: number;
    source: "cdn" | "local" | null;
    reason: string | null;
  } {
    return {
      loaded: this.loaded,
      failed: this.failed,
      loadMs: Math.round(this.loadMs),
      source: this.assetSource,
      reason: this.failReason,
    };
  }

  /**
   * 稼働状態（health）のスナップショット（バッジ・観測用）。
   *
   * - state:
   *   - "loading": ロード中（まだ推論していない）。**START_TIMEOUT_MS までの一時状態**。
   *   - "failed":  ロード失敗・起動タイムアウト（face_score は 0 のまま。無限 loading は廃止）。
   *   - "no_face": 稼働中だが顔を検出できていない（推論はしているが blendshape 0）
   *   - "ok":      稼働中かつ直近で顔を検出できている
   * - reason: failed のときの理由文字列（バッジのツールチップ・ログ用）。
   * - inferCount / faceSeenCount / inferErrorCount はデバッグ用の生カウンタ。
   *
   * 起動タイムアウトは start() の setTimeout でも failed に落とすが、health() 自身も
   * 時刻ベースで終端を計算する（タイマ未発火の環境・呼び出しタイミングに依存しない保険）。
   */
  health(nowMs: number = Date.now()): {
    state: "loading" | "failed" | "no_face" | "ok";
    reason: string | null;
    inferCount: number;
    faceSeenCount: number;
    inferErrorCount: number;
  } {
    // 起動から START_TIMEOUT_MS を超えても稼働に至っていなければ終端（failed）扱いにする。
    // （タイマ発火前に health() が呼ばれても loading で固まらないようにするための保険）。
    const timedOut =
      this.startedAtMs > 0 && nowMs - this.startedAtMs >= START_TIMEOUT_MS;

    let state: "loading" | "failed" | "no_face" | "ok";
    let reason: string | null = this.failReason;
    if (this.failed) {
      state = "failed";
    } else if (!this.loaded) {
      // ロード未完。START_TIMEOUT_MS を超えていれば終端（failed）へ。
      if (timedOut) {
        state = "failed";
        reason =
          reason ??
          `モデルのロードが${Math.round(
            START_TIMEOUT_MS / 1000
          )}秒以内に完了しませんでした（アセット配信の失敗の可能性）`;
      } else {
        state = "loading";
      }
    } else if (timedOut && this.inferCount === 0) {
      // ロードは済んだが一度も実フレームに到達していない（映像が来ていない）。
      state = "failed";
      reason =
        reason ??
        `映像フレームが${Math.round(
          START_TIMEOUT_MS / 1000
        )}秒間到達しませんでした（相手映像が再生されていない可能性）`;
    } else if (
      this.faceSeenCount > 0 &&
      nowMs - this.lastFaceAtMs < FACE_STALE_MS
    ) {
      state = "ok";
    } else {
      state = "no_face";
    }
    return {
      state,
      reason: state === "failed" ? reason : null,
      inferCount: this.inferCount,
      faceSeenCount: this.faceSeenCount,
      inferErrorCount: this.inferErrorCount,
    };
  }

  private infer(): void {
    if (!this.landmarker) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;

    this.inferCount += 1;
    try {
      const lm = this.landmarker as {
        detectForVideo: (
          v: HTMLVideoElement,
          ts: number
        ) => {
          faceBlendshapes?: Array<{
            categories: Array<{ categoryName: string; score: number }>;
          }>;
        };
      };
      const result = lm.detectForVideo(this.video, performance.now());
      const shapes = result.faceBlendshapes?.[0]?.categories ?? [];
      if (shapes.length === 0) {
        this.lastScore = 0;
        this.lastTop = [];
        return;
      }

      // 顔（blendshape）を検出できた。
      this.faceSeenCount += 1;
      this.lastFaceAtMs = Date.now();

      // mouthSmile 系 blendshape の平均を face_score とする。
      let sum = 0;
      let n = 0;
      for (const c of shapes) {
        const name = c.categoryName.toLowerCase();
        if (this.p.smileBlendshapes.some((s) => name.includes(s))) {
          sum += c.score;
          n += 1;
        }
      }
      this.lastScore = n > 0 ? Math.min(1, Math.max(0, sum / n)) : 0;

      // 上位3 blendshape 名を記録（metadata.blendshapes_top）。
      this.lastTop = [...shapes]
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((c) => c.categoryName);
    } catch {
      // 推論の単発失敗はスコアを据え置いてスキップ（カウンタは進める）。
      this.inferErrorCount += 1;
    }
  }
}

// 直近この時間内に顔を検出できていれば「稼働中（ok）」とみなす（ms）。
// 推論間隔 200ms に対し十分な猶予。表情が無い瞬間で no_face に落ちないようにする。
const FACE_STALE_MS = 3000;

// 起動タイムアウト（ms）。start() から この時間内に稼働（ロード完了＋最低1回の推論到達）
// に至らなければ health を "loading" のまま固めず "failed"（理由付き）へ落とす。
// brief 指定「起動から10秒で loading のままなら failed（理由付き）へ」に対応。
// 正常時のロードは warm 約350ms・cold 約1〜2秒（README）なので 10秒は十分な猶予。
export const START_TIMEOUT_MS = 10_000;
