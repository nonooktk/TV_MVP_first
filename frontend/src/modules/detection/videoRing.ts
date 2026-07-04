// 委託コア②（検知キャプチャ）: 映像 look-back 用リングバッファ
//
// 相手映像（<video>要素）を約200ms間隔で低解像度canvasに描画し、直近3コマを
// JPEG Blob として保持する。発火時に「発火前のコマ」を連写に混ぜるための look-back。
//
// docs/data-contract.md 付録 metadata の lookback=true を付けるコマの供給源。

/** look-back の1コマ。 */
export interface LookbackFrame {
  blob: Blob;
  /** 取得時刻（epoch ms）。 */
  capturedAtMs: number;
}

/** videoRing の設定。 */
export interface VideoRingParams {
  /** サンプル間隔（ms）。 */
  intervalMs: number;
  /** 保持するコマ数（直近 N コマ）。 */
  size: number;
  /** 低解像度canvasの長辺（px）。look-back は選別用なので小さくてよい。 */
  maxEdge: number;
  /** JPEG 品質（0〜1）。 */
  quality: number;
}

export const DEFAULT_VIDEO_RING_PARAMS: VideoRingParams = {
  intervalMs: 200,
  size: 3,
  maxEdge: 320,
  quality: 0.6,
};

/**
 * 相手映像の直近コマを保持するリングバッファ。
 * start() で 200ms 間隔の取り込みを開始、snapshot() で現在の保持コマを取り出す。
 */
export class VideoRing {
  private readonly video: HTMLVideoElement;
  private readonly p: VideoRingParams;
  private readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private frames: LookbackFrame[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(video: HTMLVideoElement, params: Partial<VideoRingParams> = {}) {
    this.video = video;
    this.p = { ...DEFAULT_VIDEO_RING_PARAMS, ...params };
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.capture();
    }, this.p.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 現在保持している look-back コマ（古い順）のコピーを返す。 */
  snapshot(): LookbackFrame[] {
    return [...this.frames];
  }

  private async capture(): Promise<void> {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh || !this.ctx) return; // まだ映像が来ていない

    const scale = Math.min(1, this.p.maxEdge / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;

    try {
      this.ctx.drawImage(this.video, 0, 0, w, h);
    } catch {
      return; // 描画不可（トラック未確立など）はスキップ
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      this.canvas.toBlob((b) => resolve(b), "image/jpeg", this.p.quality)
    );
    if (!blob) return;

    this.frames.push({ blob, capturedAtMs: Date.now() });
    if (this.frames.length > this.p.size) {
      this.frames.shift();
    }
  }
}
