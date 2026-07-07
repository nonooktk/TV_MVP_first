// 委託コア②（検知キャプチャ）: スペクトル重心トリガー（改良2・純粋ロジック）
//
// 声色の変化（笑い声・高い声・興奮）を、音圧（RMS）とは独立の軸で捉えるためのトリガー。
// スペクトル重心（Spectral Centroid, Hz）は「音の明るさ／高さの重心」で、
// 笑い声や興奮した高い声で上がりやすい。音圧が変わらなくても声色が変われば発火し得る。
//
// 設計（承認済み仕様）:
//   - 入力は発話フレームのスペクトル重心(Hz)。50ms 間隔で算出し push する
//     （**発話フレームのみ**。非発話時は無視＝呼び出し側でゲートする）。
//   - 基準（平常の重心）は **発話フレームの中央値**（直近 windowMs のローリング窓・改良1と同じ仕組み）。
//   - 発火条件: 現在の重心が基準比 +riseRatio（+20%）を sustainMs（200ms）持続 → 発火。
//   - クールダウンは RMS/STT と共有（呼び出し側の handleTrigger 経路の共有クールダウン4秒に委ねる）。
//     このクラスは重心固有の持続判定までを担い、発火可否イベントを返す（共有クールダウンは上位）。
//
// DOM / WebAudio 非依存の純粋ロジック（vitest で単体テストする）。

import { RollingMedian } from "./rmsTrigger";

/** スペクトル重心トリガーのパラメータ（支給初期値。チューニングは検収対象外）。 */
export interface CentroidTriggerParams {
  /** サンプル間隔の想定値（ms）。持続の時間換算に使う。 */
  sampleIntervalMs: number;
  /** 基準（発話重心中央値）のローリング窓（ms）。改良1と同じ20秒。 */
  medianWindowMs: number;
  /** 発火とみなす基準比の上昇率（例 1.2 = +20%）。CENTROID_RISE_RATIO。 */
  riseRatio: number;
  /** 発火に必要な上昇の持続時間（ms）。CENTROID_SUSTAIN_MS。 */
  sustainMs: number;
}

/**
 * 支給初期値（docs/detection-params.md）。
 * ※ チューニングは検収対象外（実測で調整する前提）。
 */
export const DEFAULT_CENTROID_PARAMS: CentroidTriggerParams = {
  sampleIntervalMs: 50,
  medianWindowMs: 20000, // 改良1の発話中央値窓と同じ20秒
  riseRatio: 1.2, // 基準比 +20%（CENTROID_RISE_RATIO）
  sustainMs: 200, // +20% を 200ms 持続で発火（CENTROID_SUSTAIN_MS）
};

/** 重心発火時に外へ渡す情報（metadata の spectral_centroid / centroid_rise_ratio の素）。 */
export interface CentroidTriggerEvent {
  /** 発火時のスペクトル重心（Hz）。metadata.spectral_centroid に対応。 */
  centroidHz: number;
  /** 発火時の基準比（現在値 / 基準・例 1.25）。metadata.centroid_rise_ratio に対応。 */
  riseRatio: number;
  /** 発火時点の基準重心（Hz）。デバッグ・観測用。 */
  baselineHz: number;
}

/** 観測用の内部状態スナップショット（デバッグパネル用）。 */
export interface CentroidTriggerState {
  /** 直近サンプルのスペクトル重心（Hz）。未サンプルは null。 */
  lastCentroidHz: number | null;
  /** 基準重心（発話中央値・Hz）。窓が空なら null。 */
  baselineHz: number | null;
  /** 直近の基準比（現在値 / 基準）。算出不能なら null。 */
  riseRatio: number | null;
  /** 上昇（基準比 ≥ riseRatio）の持続累積（ms）。sustainMs に達すると発火する。 */
  sustainedMs: number;
}

/**
 * スペクトル重心の発火判定器（改良2）。
 *
 * push(centroidHz, nowMs) を **発話フレームのみ** 約50ms間隔で呼ぶ。
 * 基準比が riseRatio 以上を sustainMs 続けたら CentroidTriggerEvent を返す（満たさなければ null）。
 * クールダウンは持たない（上位 handleTrigger の共有クールダウン4秒に委ねる）。
 */
export class CentroidTrigger {
  private readonly p: CentroidTriggerParams;
  private readonly median: RollingMedian;

  private lastCentroidHz: number | null = null;
  private lastTimeMs: number | null = null;
  private baselineHz: number | null = null;
  private sustainedMs = 0;

  constructor(params: Partial<CentroidTriggerParams> = {}) {
    this.p = { ...DEFAULT_CENTROID_PARAMS, ...params };
    this.median = new RollingMedian(this.p.medianWindowMs);
  }

  /**
   * 発話フレーム1つ（スペクトル重心 Hz・時刻）を投入する。
   * 発火条件を満たしたら CentroidTriggerEvent、しなければ null。
   *
   * ※ 非発話フレームは呼び出し側で弾く（このメソッドに渡さない）。
   */
  push(centroidHz: number, nowMs: number): CentroidTriggerEvent | null {
    const dt =
      this.lastTimeMs === null
        ? this.p.sampleIntervalMs
        : Math.max(0, Math.min(nowMs - this.lastTimeMs, this.p.sampleIntervalMs * 4));
    this.lastTimeMs = nowMs;
    this.lastCentroidHz = centroidHz;

    // 基準（発話重心の中央値）を更新する。
    // 盛り上がり（基準比 ≥ riseRatio）のフレームは窓に入れない
    //（改良1の RMS と同じ思想＝ピークで基準を吊り上げない）。判定は「更新前の基準」で行う。
    const prevBaseline = this.median.median();
    const isRising =
      prevBaseline !== null && prevBaseline > 0
        ? centroidHz / prevBaseline >= this.p.riseRatio
        : false;
    if (!isRising) {
      this.median.push(centroidHz, nowMs);
    }
    this.baselineHz = this.median.median();

    // 基準が未確立（窓が空・0以下）の間は発火判定しない。
    if (this.baselineHz === null || this.baselineHz <= 0) {
      this.sustainedMs = 0;
      return null;
    }

    const ratio = centroidHz / this.baselineHz;
    if (ratio >= this.p.riseRatio) {
      this.sustainedMs += dt;
    } else {
      this.sustainedMs = 0;
    }

    if (this.sustainedMs >= this.p.sustainMs) {
      this.sustainedMs = 0;
      return {
        centroidHz,
        riseRatio: ratio,
        baselineHz: this.baselineHz,
      };
    }
    return null;
  }

  /** その時点の重心サンプル（Hz / 基準比）を返す（コマごと metadata 用・読み取り専用）。 */
  sample(): { centroidHz: number | null; riseRatio: number | null } {
    let riseRatio: number | null = null;
    if (
      this.lastCentroidHz !== null &&
      this.baselineHz !== null &&
      this.baselineHz > 0
    ) {
      riseRatio = this.lastCentroidHz / this.baselineHz;
    }
    return { centroidHz: this.lastCentroidHz, riseRatio };
  }

  /** 観測用の内部状態スナップショット。 */
  snapshot(): CentroidTriggerState {
    const riseRatio =
      this.lastCentroidHz !== null && this.baselineHz !== null && this.baselineHz > 0
        ? this.lastCentroidHz / this.baselineHz
        : null;
    return {
      lastCentroidHz: this.lastCentroidHz,
      baselineHz: this.baselineHz,
      riseRatio,
      sustainedMs: this.sustainedMs,
    };
  }
}

/**
 * AnalyserNode の周波数データ（getFloatFrequencyData の dB 配列）からスペクトル重心(Hz)を算出する
 * 純粋関数（DOM 非依存・テスト可能）。
 *
 * - freqDb: 各ビンの振幅（dB・getFloatFrequencyData の出力）。長さ = fftSize/2。
 * - sampleRate: AudioContext のサンプリングレート（Hz）。ビン i の周波数 = i * sampleRate / fftSize。
 *
 * 重心 = Σ(f_i * mag_i) / Σ(mag_i)。mag は dB を線形振幅へ戻して重み付けする。
 * 有効なエネルギーが無い（全て下限）場合は 0 を返す。
 */
export function spectralCentroidHz(freqDb: Float32Array, sampleRate: number): number {
  const n = freqDb.length;
  if (n === 0) return 0;
  const binHz = sampleRate / (n * 2); // fftSize = n*2
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const db = freqDb[i];
    // dB を線形振幅へ（-Infinity/極小は 0 相当）。10^(dB/20)。
    if (!isFinite(db) || db <= -140) continue;
    const mag = Math.pow(10, db / 20);
    weighted += i * binHz * mag;
    total += mag;
  }
  if (total <= 0) return 0;
  return weighted / total;
}
