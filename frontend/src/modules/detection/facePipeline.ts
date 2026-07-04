// 委託コア②（検知キャプチャ）: MediaPipe FaceLandmarker による表情スコア算出
//
// @mediapipe/tasks-vision の FaceLandmarker で相手映像から face_score を約200ms間隔で
// 算出する。face_score は mouthSmile 系 blendshape 中心の 0〜1。
//
// 【アセット配信】WASM とモデル（.task）は frontend/public/mediapipe/ にコピーして
// ローカル配信する（CDN依存を避ける）。コピー手順は modules/detection/README.md に記録。
//   - WASM:  public/mediapipe/wasm/           （npm パッケージ node_modules/@mediapipe/tasks-vision/wasm/ をコピー）
//   - モデル: public/mediapipe/models/face_landmarker.task （Google Storage から取得）
//
// 【耐障害性】ロード失敗時は face_score=0 で継続する（検知全体を止めない）。
//
// SSR 回避のため @mediapipe/tasks-vision は dynamic import する。

const WASM_PATH = "/mediapipe/wasm";
const MODEL_PATH = "/mediapipe/models/face_landmarker.task";

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

  constructor(video: HTMLVideoElement, params: Partial<FacePipelineParams> = {}) {
    this.video = video;
    this.p = { ...DEFAULT_FACE_PARAMS, ...params };
  }

  /** モデルをロードして推論ループを開始する。失敗しても例外は投げない。 */
  async start(): Promise<void> {
    const t0 =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      const vision = await import("@mediapipe/tasks-vision");
      const { FilesetResolver, FaceLandmarker } = vision;
      const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      });
      this.loaded = true;
      this.loadMs =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    } catch (e) {
      // ロード失敗（アセット未配置・WASM非対応など）は検知全体を止めず face_score=0 で継続。
      this.failed = true;
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

  /** ロード状態（観測用）。loadMs は成功時のロード所要時間（ms）。 */
  status(): { loaded: boolean; failed: boolean; loadMs: number } {
    return { loaded: this.loaded, failed: this.failed, loadMs: Math.round(this.loadMs) };
  }

  private infer(): void {
    if (!this.landmarker) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;

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
      // 推論の単発失敗はスコアを据え置いてスキップ。
    }
  }
}
