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

/** その1枚の時点の音圧サンプル（コマごと採点用）。 */
export interface RmsSample {
  /** その時点の音圧（dB）。metadata.rms_db に対応。取得できなければ undefined。 */
  rmsDb?: number;
  /** その時点の baseline 比上昇（dB）。metadata.rms_rise に対応。 */
  rmsRise?: number;
}

/** 連写で撮れた1枚。 */
export interface BurstPhoto {
  blob: Blob;
  capturedAtMs: number;
  /** look-back（発火前バッファ由来）か否か。metadata.lookback に対応。 */
  lookback: boolean;
  /**
   * この1枚を撮った時点の face_score（0〜1）。
   * sampleFaceScore が渡されたときのみ設定される（コマごと採点）。
   * look-back コマは撮影が過去のため「発火時点の直近値」を共有する。
   */
  faceScore?: number;
  /**
   * この1枚を撮った時点の音圧（rms_db / rms_rise）。
   * sampleRms が渡されたときのみ設定される（コマごと採点）。
   * look-back コマは撮影が過去のため「発火時点の直近値」を共有する。
   */
  rms?: RmsSample;
}

/** 連写のオプション。 */
export interface CaptureBurstOptions {
  /**
   * 各ショット直後に呼ばれ、その時点の face_score（0〜1）を返す。
   * これによりコマごとの metadata.face_score を記録できる（発火瞬間の1値共有を廃止）。
   * 未指定なら faceScore は付かない。
   */
  sampleFaceScore?: () => number;
  /**
   * look-back コマに付ける face_score（直近値）。sampleFaceScore がある場合のみ使う。
   * 過去コマは撮り直せないため発火時点の直近値でよい（brief 指定）。
   */
  lookbackFaceScore?: number;
  /**
   * 各ショット直後に呼ばれ、その時点の音圧（rms_db / rms_rise）を返す。
   * これによりコマごとの metadata.rms_db / rms_rise を記録できる
   * （発火瞬間の1値を全コマで共有するのを廃止＝無表情環境でも連写内に差がつく）。
   * 未指定なら rms は付かない。
   */
  sampleRms?: () => RmsSample;
  /**
   * look-back コマに付ける音圧（発火時点の直近値）。sampleRms がある場合のみ使う。
   * 過去コマは撮り直せないため発火時点の直近値を共有する（face_score と同じ扱い）。
   */
  lookbackRms?: RmsSample;
}

/**
 * 連写を実行する。
 * lookbackFrames を先頭（lookback=true）に置き、続けて params.frames 枚を撮る。
 * 合計は最大 lookbackFrames.length + params.frames 枚。
 */
export async function captureBurst(
  video: HTMLVideoElement,
  lookbackFrames: LookbackFrame[],
  params: Partial<BurstParams> = {},
  options: CaptureBurstOptions = {}
): Promise<BurstPhoto[]> {
  const p = { ...DEFAULT_BURST_PARAMS, ...params };
  const photos: BurstPhoto[] = [];
  const { sampleFaceScore, lookbackFaceScore, sampleRms, lookbackRms } = options;

  // 1) look-back コマ（発火前）を先頭に入れる。
  //    過去コマなので face_score / 音圧は発火時点の直近値（lookback*）を共有する。
  for (const f of lookbackFrames) {
    photos.push({
      blob: f.blob,
      capturedAtMs: f.capturedAtMs,
      lookback: true,
      faceScore: sampleFaceScore ? lookbackFaceScore ?? 0 : undefined,
      rms: sampleRms ? lookbackRms ?? {} : undefined,
    });
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
    // この1枚を撮った瞬間の face_score / 音圧を採点（コマごと採点）。
    // toBlob は非同期なので、drawImage 直後＝実フレームに最も近いタイミングで採る。
    const faceScore = sampleFaceScore ? sampleFaceScore() : undefined;
    const rms = sampleRms ? sampleRms() : undefined;

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", p.quality)
    );
    if (blob) {
      photos.push({ blob, capturedAtMs: Date.now(), lookback: false, faceScore, rms });
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
