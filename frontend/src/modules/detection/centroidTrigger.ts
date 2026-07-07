// 委託コア②（検知キャプチャ）: スペクトル重心トリガー（改良2・純粋ロジック）
//
// 声色の変化（笑い声・高い声・興奮）を、音圧（RMS）とは独立の軸で捉えるためのトリガー。
// スペクトル重心（Spectral Centroid, Hz）は「音の明るさ／高さの重心」で、
// 笑い声や興奮した高い声で上がりやすい。音圧が変わらなくても声色が変われば発火し得る。
//
// 設計（承認済み仕様）:
//   - 入力は毎フレームのスペクトル重心(Hz)。50ms 間隔で算出し push(centroidHz, isSpeech, nowMs)
//     を呼ぶ。**発話ゲート成立（isSpeech=true）のフレームのみ**中央値窓・持続カウントの対象。
//     非発話フレーム（isSpeech=false）は基準を動かさず、**持続カウントをリセット**する
//     （2026-07-07 実測フィードバック: 無言時の発火排除を厳密化）。
//   - 基準（平常の重心）は **発話フレームの中央値**（直近 windowMs のローリング窓・改良1と同じ仕組み）。
//   - 発火条件（2026-07-07 実測フィードバックで厳密化）: 現在の重心が基準比 +riseRatio（+30%）を
//     sustainMs（200ms）持続 **かつ** 発話ゲート成立 → 発火。
//   - リアーム: 発火後は「基準比が riseRatio 未満に一度戻る」まで再発火しない（armed=false→true）。
//   - クールダウンは RMS/STT と共有（呼び出し側の handleTrigger 経路の共有クールダウン8秒に委ねる）。
//     このクラスは重心固有の持続判定・発話ゲート判定・リアームまでを担い、発火可否イベントを返す
//     （共有クールダウンは上位）。
//
// DOM / WebAudio 非依存の純粋ロジック（vitest で単体テストする）。

import { RollingMedian } from "./rmsTrigger";

/** スペクトル重心トリガーのパラメータ（支給初期値。チューニングは検収対象外）。 */
export interface CentroidTriggerParams {
  /** サンプル間隔の想定値（ms）。持続の時間換算に使う。 */
  sampleIntervalMs: number;
  /** 基準（発話重心中央値）のローリング窓（ms）。改良1と同じ20秒。 */
  medianWindowMs: number;
  /**
   * 発火とみなす基準比の上昇率（例 1.3 = +30%）。CENTROID_RISE_RATIO。
   * 2026-07-07 実測フィードバックにより +20%（1.2）→ +30%（1.3）。
   */
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
  // 基準比 +30%（CENTROID_RISE_RATIO）。2026-07-07 実測フィードバックにより +20%→+30%。
  riseRatio: 1.3,
  sustainMs: 200, // +30% を 200ms 持続で発火（CENTROID_SUSTAIN_MS）
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
  /**
   * リアーム済み（再発火可能）か（2026-07-07 追加）。
   * 発火直後は false になり、基準比が riseRatio 未満に一度戻ると true に復帰する。
   */
  armed: boolean;
}

/**
 * スペクトル重心の発火判定器（改良2）。
 *
 * push(centroidHz, isSpeech, nowMs) を毎フレーム（約50ms間隔）呼ぶ。
 * **発話ゲート成立（isSpeech=true）のフレームのみ**中央値窓・持続カウントの対象とし、
 * 基準比が riseRatio 以上を sustainMs 続けた**かつ発話ゲート成立**なら CentroidTriggerEvent を
 * 返す（満たさなければ null）。非発話フレームは基準を動かさず持続カウントをリセットする
 * （2026-07-07 実測フィードバック: 無言時の発火排除の厳密化）。
 * クールダウンは持たない（上位 handleTrigger の共有クールダウン8秒に委ねる）。
 */
export class CentroidTrigger {
  private readonly p: CentroidTriggerParams;
  private readonly median: RollingMedian;

  private lastCentroidHz: number | null = null;
  private lastTimeMs: number | null = null;
  private baselineHz: number | null = null;
  private sustainedMs = 0;
  // リアーム済み（再発火可能）か（2026-07-07 追加）。発火直後は false、
  // 基準比が riseRatio 未満に戻ると true へ復帰する。
  private armed = true;

  constructor(params: Partial<CentroidTriggerParams> = {}) {
    this.p = { ...DEFAULT_CENTROID_PARAMS, ...params };
    this.median = new RollingMedian(this.p.medianWindowMs);
  }

  /**
   * フレーム1つ（スペクトル重心 Hz・発話ゲート成立か・時刻）を投入する。
   * 発火条件（基準比 ≥ riseRatio を sustainMs 持続 **かつ** isSpeech）を満たしたら
   * CentroidTriggerEvent、しなければ null。
   *
   * @param centroidHz このフレームのスペクトル重心（Hz）
   * @param isSpeech 発話ゲート成立か（音圧が ノイズフロア+8dB 以上）。
   *   false（非発話）のフレームは基準（中央値窓）を更新せず、持続カウントをリセットする。
   * @param nowMs 現在時刻（ms）
   */
  push(centroidHz: number, isSpeech: boolean, nowMs: number): CentroidTriggerEvent | null {
    const dt =
      this.lastTimeMs === null
        ? this.p.sampleIntervalMs
        : Math.max(0, Math.min(nowMs - this.lastTimeMs, this.p.sampleIntervalMs * 4));
    this.lastTimeMs = nowMs;
    this.lastCentroidHz = centroidHz;

    // 【発話ゲート不成立（無言）】基準を動かさず、持続カウントをリセットして終える。
    // 2026-07-07 実測フィードバック: 無言時に発火・持続蓄積が起きないよう厳密化。
    if (!isSpeech) {
      this.sustainedMs = 0;
      return null;
    }

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

    // 【リアーム（2026-07-07 追加）】比率が riseRatio 未満に戻ったら再発火可能にする。
    if (ratio < this.p.riseRatio) {
      this.armed = true;
    }

    if (ratio >= this.p.riseRatio) {
      this.sustainedMs += dt;
    } else {
      this.sustainedMs = 0;
    }

    // リアーム未済（前回発火から比率が閾値未満へ戻っていない）は発火しない。
    if (!this.armed) {
      return null;
    }

    if (this.sustainedMs >= this.p.sustainMs) {
      this.sustainedMs = 0;
      this.armed = false; // リアーム解除: 比率が閾値未満に戻るまで再発火しない
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
      armed: this.armed,
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
