// 委託コア②（検知キャプチャ）: 発火時の連写キャプチャ
//
// 発火時に相手映像から連写10枚（約2秒・200ms間隔・通話解像度でcanvasキャプチャ）を撮る。
// これに look-back コマ（発火前バッファ由来）を先頭に足したものが「その発火の候補群」になる。
//
// docs/detection-params.md: 連写=10枚・約2秒・200ms間隔。

import type { LookbackFrame } from "./videoRing";

/** 連写の設定（支給初期値。チューニングは検収対象外）。 */
export interface BurstParams {
  /** 連写枚数（look-back を除く）。 */
  frames: number;
  /** 連写間隔（ms）。 */
  intervalMs: number;
  /** JPEG 品質（0〜1）。連写は候補本体なので look-back より高品質。 */
  quality: number;
  /** 出力の長辺上限（px）。0 以下なら通話解像度そのまま。 */
  maxEdge: number;
}

export const DEFAULT_BURST_PARAMS: BurstParams = {
  frames: 10, // 連写10枚
  intervalMs: 200, // 200ms間隔（10枚で約2秒）
  quality: 0.82,
  maxEdge: 0, // 通話解像度のまま
};

/** 連写で撮れた1枚。 */
export interface BurstPhoto {
  blob: Blob;
  capturedAtMs: number;
  /** look-back（発火前バッファ由来）か否か。metadata.lookback に対応。 */
  lookback: boolean;
}

/**
 * 連写を実行する。
 * lookbackFrames を先頭（lookback=true）に置き、続けて params.frames 枚を撮る。
 * 合計は最大 lookbackFrames.length + params.frames 枚。
 */
export async function captureBurst(
  video: HTMLVideoElement,
  lookbackFrames: LookbackFrame[],
  params: Partial<BurstParams> = {}
): Promise<BurstPhoto[]> {
  const p = { ...DEFAULT_BURST_PARAMS, ...params };
  const photos: BurstPhoto[] = [];

  // 1) look-back コマ（発火前）を先頭に入れる。
  for (const f of lookbackFrames) {
    photos.push({ blob: f.blob, capturedAtMs: f.capturedAtMs, lookback: true });
  }

  // 2) 連写用 canvas。
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const grab = async (): Promise<void> => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !ctx) return;

    let w = vw;
    let h = vh;
    if (p.maxEdge > 0) {
      const scale = Math.min(1, p.maxEdge / Math.max(vw, vh));
      w = Math.max(1, Math.round(vw * scale));
      h = Math.max(1, Math.round(vh * scale));
    }
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    try {
      ctx.drawImage(video, 0, 0, w, h);
    } catch {
      return;
    }
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", p.quality)
    );
    if (blob) {
      photos.push({ blob, capturedAtMs: Date.now(), lookback: false });
    }
  };

  // 3) 200ms間隔で frames 枚。1枚目は即時、以降は intervalMs 待ち。
  for (let i = 0; i < p.frames; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, p.intervalMs));
    }
    await grab();
  }

  return photos;
}
