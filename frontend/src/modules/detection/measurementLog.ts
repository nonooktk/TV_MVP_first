// 委託コア②（検知キャプチャ）: 計測ログ（トリガーパラメータ設計の実地テスト用オブザーバー）
//
// 目的: 実地テストで「全シナリオでの rise / 重心比の分布」と「全発火イベントの詳細」を
// 後から集計できるようにする。検知本体（rmsTrigger / centroidTrigger / index.ts）の
// 挙動には一切干渉しない**読み取り専用オブザーバー**であり、フックは snapshot 取得と
// 発火 onEvent 経由のみで行う。
//
// 記録するもの:
//   1. 1秒ごとのサマリサンプル（MeasurementSample）。瞬間値ではなく「その1秒間のピーク
//      ホールド」を含める（sustain 150ms の短いイベントを1Hzサンプリングで取りこぼさない
//      ため）。
//   2. 発火イベント（MeasurementTriggerEvent）。発火瞬間の全スナップショット＋完了時の
//      photo_count・部分保存（タイムアウト救済）フラグ。
//
// メモリ上限: サンプルは最大 3600 件（60分相当）、イベントは最大 200 件のリングバッファ。
// エクスポートは JSON（version 1・スネークケース・params スナップショット付き）。
//
// このファイルは DOM 非依存の純粋ロジック（vitest で単体テストする）。

import type { RmsTriggerParams, RmsTriggerState } from "./rmsTrigger";
import type { CentroidTriggerParams, CentroidTriggerState } from "./centroidTrigger";
import type { TriggerReason } from "./rmsTrigger";

/** 1秒ごとのサマリサンプル（JSON スネークケース。docs/detection-params.md 参照）。 */
export interface MeasurementSample {
  /** 通話開始からの秒。 */
  t: number;
  /** この1秒間の rise の最大値（dB）。ピークホールド。 */
  rise_peak_db: number | null;
  /** 現在値（dB）。 */
  rms_db: number | null;
  baseline_db: number | null;
  mode: "provisional" | "speech";
  speech_accum_ms: number;
  speech_median_db: number | null;
  armed: boolean;
  vad_floor_db: number;
  noise_floor_db: number | null;
  /** この1秒間の発話フレーム率（0〜1）。 */
  speech_ratio: number;
  centroid_hz: number | null;
  centroid_baseline_hz: number | null;
  /** この1秒間の基準比（centroid）最大値。 */
  centroid_ratio_peak: number | null;
  /**
   * この1秒間の基準比（centroid）の**中央値**（平滑値）。2026-07-18 追加。
   * ピーク（centroid_ratio_peak）と併記し、Phase B で「平滑重心なら通常発話と識別できるか」を
   * 検証するための材料（重心トリガーは既定停止したが計測は継続する）。窓が空なら null。
   */
  centroid_ratio_median: number | null;
  /** 自ゲイン現在値（dB）。取得できる場合のみ。 */
  auto_gain_db: number | null;
  /**
   * この1秒間でノイズゲート（固定 -50dB）未満だったフレーム率（0〜1）。
   * 2026-07-10 追加（ノイズゲート）。elder レーン（高齢者側リモート音声）の観測。
   */
  gate_ratio: number;
  /**
   * family lane（家族側ローカルマイク・声トリガーの両側化）のこの1秒間の rise 最大値（dB）。
   * ピークホールド。family lane 未接続（familyAudioTrack 未指定）の通話では常に null。
   * 2026-07-10 追加。
   */
  family_rise_peak_db: number | null;
  /**
   * family lane のこの1秒間の重心基準比（centroid）最大値。ピークホールド。
   * family lane 未接続の通話では常に null。2026-07-10 追加。
   */
  family_centroid_ratio_peak: number | null;
  /**
   * 家族側の表情スコア（face_score）のこの1秒間の最大値。ピークホールド。
   * 顔検知の家族側化・顔トリガー（Phase 2）。顔検知なし（familyVideoTrack 未指定）の
   * 通話では常に null。sustain 500ms の顔トリガーを1Hzサンプリングで取りこぼさないため。
   */
  face_score_peak: number | null;
  /**
   * 顔トリガーの本人ベースライン（直近10秒ローリング中央値・その1秒毎の現在値）。
   * 2026-07-18 追加（顔トリガーの「変化」化）。顔検知なしの通話では常に null。
   */
  face_baseline: number | null;
}

/** 発火イベント（発火瞬間の全スナップショット＋完了時の情報）。 */
export interface MeasurementTriggerEvent {
  /** 通話開始からの秒。 */
  t: number;
  type: "trigger";
  reason: TriggerReason;
  /** 発火瞬間の RMS スナップショット。 */
  rms: RmsTriggerState;
  /** 発火瞬間の重心スナップショット。 */
  centroid: CentroidTriggerState;
  /** 発火瞬間の自ゲイン（dB）。取得できる場合のみ。 */
  auto_gain_db: number | null;
  /** 完了時に埋める（保存完了まで null のまま観測されることはない。record 呼び出し時に確定させる）。 */
  photo_count: number | null;
  /** 部分保存（タイムアウト救済）だったか。 */
  partial_save: boolean;
  /**
   * 発火元（声トリガーの両側化・2026-07-10 追加）。
   * "elder"=高齢者側リモート音声／"family"=家族側ローカルマイク（第2系統）。
   * 省略時は "elder"（recordTriggerStart の既定値。既存呼び出し・過去データとの互換）。
   */
  source: "elder" | "family";
}

/**
 * スパイク棄却イベント（発火確認窓で破棄・2026-07-18 追加）。
 * rmsTrigger の確認窓中に非発話へ落ちて発火を破棄したときに記録する
 * （咳・くしゃみ等の破裂音対策＝C1台本の効果測定用）。
 */
export interface MeasurementSpikeRejectedEvent {
  /** 通話開始からの秒。 */
  t: number;
  type: "spike_rejected";
  /** 破棄が起きたレーン（"elder"／"family"）。 */
  source: "elder" | "family";
}

/**
 * シナリオマーカー（Round 2 の集計自動化・2026-07-18 追加）。
 * 計測UIの「打刻」ボタンで、その瞬間に実施中のシナリオ（A1〜C3・自由入力）を記録する。
 */
export interface MeasurementMarkerEvent {
  /** 通話開始からの秒。 */
  t: number;
  type: "marker";
  /** シナリオラベル（例 "A1"・"C2"・自由入力文字列）。 */
  label: string;
}

/** 計測ログに記録される全イベント（発火・スパイク棄却・マーカーの直和）。 */
export type MeasurementEvent =
  | MeasurementTriggerEvent
  | MeasurementSpikeRejectedEvent
  | MeasurementMarkerEvent;

/** エクスポート JSON のトップレベル形式。 */
export interface MeasurementLogExport {
  version: 1;
  call_id: string;
  exported_at: string;
  params: {
    rms: RmsTriggerParams;
    centroid: CentroidTriggerParams;
  };
  samples: MeasurementSample[];
  events: MeasurementEvent[];
}

/** サンプルのリング上限（1Hz × 3600秒 = 60分相当）。 */
export const MAX_SAMPLES = 3600;
/** イベントのリング上限。 */
export const MAX_EVENTS = 200;
/** サマリサンプルの記録間隔（ms）。 */
export const SAMPLE_INTERVAL_MS = 1000;

/** 1秒間の内訳を集計するための可変アキュムレータ（内部専用）。 */
interface Accumulator {
  risePeakDb: number | null;
  centroidRatioPeak: number | null;
  /** この1秒間の重心基準比サンプル（中央値 centroid_ratio_median 算出用・2026-07-18 追加）。 */
  centroidRatios: number[];
  speechFrames: number;
  totalFrames: number;
  /** ノイズゲート（固定 -50dB）未満だったフレーム数（2026-07-10 追加）。 */
  gatedFrames: number;
  /** family lane（家族側マイク）のこの1秒間の rise 最大値。2026-07-10 追加。 */
  familyRisePeakDb: number | null;
  /** family lane のこの1秒間の重心基準比の最大値。2026-07-10 追加。 */
  familyCentroidRatioPeak: number | null;
  /** 家族側の表情スコアのこの1秒間の最大値（顔トリガー・Phase 2）。 */
  faceScorePeak: number | null;
}

function freshAccumulator(): Accumulator {
  return {
    risePeakDb: null,
    centroidRatioPeak: null,
    centroidRatios: [],
    speechFrames: 0,
    totalFrames: 0,
    gatedFrames: 0,
    familyRisePeakDb: null,
    familyCentroidRatioPeak: null,
    faceScorePeak: null,
  };
}

/** 数値配列の中央値（空なら null）。centroid_ratio_median 用の内部ヘルパ。 */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 計測ロガー本体。
 *
 * 使い方:
 *   const log = new MeasurementLog(callId, params);
 *   // 発火判定と同じ 50ms 間隔で、その瞬間の rise / 発話判定 / 重心比を投入する。
 *   log.observeFrame({ riseDb, isSpeech, centroidRatio }, nowMs);
 *   // 1秒間隔で（あるいは observeFrame 内部で自動集計して）サマリを確定する。
 *   log.tick(snapshotProvider, nowMs);
 *   // 発火時に記録する。
 *   log.recordTriggerStart(reason, rmsSnapshot, centroidSnapshot, autoGainDb, nowMs);
 *   log.recordTriggerComplete(photoCount, partialSave);
 *
 * 読み取り専用オブザーバーであり、検知本体のロジックには一切書き込まない。
 */
export class MeasurementLog {
  readonly callId: string;
  private readonly startMs: number;
  private readonly rmsParams: RmsTriggerParams;
  private readonly centroidParams: CentroidTriggerParams;

  private samples: MeasurementSample[] = [];
  private events: MeasurementEvent[] = [];
  private acc: Accumulator = freshAccumulator();
  private lastTickMs: number | null = null;
  // 直近の未完了イベント（recordTriggerComplete で埋める）。
  private pendingEvent: MeasurementTriggerEvent | null = null;

  constructor(
    callId: string,
    params: { rms: RmsTriggerParams; centroid: CentroidTriggerParams },
    startMs = Date.now()
  ) {
    this.callId = callId;
    this.startMs = startMs;
    this.rmsParams = params.rms;
    this.centroidParams = params.centroid;
  }

  /** 通話開始からの秒（小数切り捨て）。 */
  private elapsedSec(nowMs: number): number {
    return Math.floor((nowMs - this.startMs) / 1000);
  }

  /**
   * 1フレーム分の観測値を投入する（発火判定と同じ約50ms間隔を想定）。
   * この1秒間のピークホールド（rise・重心比の最大値）と発話フレーム率の集計に使う。
   * 読み取り専用（rmsTrigger / centroidTrigger の内部状態には触れない）。
   */
  observeFrame(
    frame: {
      riseDb: number | null;
      isSpeech: boolean;
      centroidRatio: number | null;
      /**
       * このフレームがノイズゲート（固定 -50dB）未満だったか（2026-07-10 追加）。
       * 省略時は false 扱い（既存呼び出し・既存テストとの後方互換）。
       */
      gated?: boolean;
    },
    _nowMs: number
  ): void {
    this.acc.totalFrames += 1;
    if (frame.isSpeech) this.acc.speechFrames += 1;
    if (frame.gated) this.acc.gatedFrames += 1;
    if (frame.riseDb !== null) {
      this.acc.risePeakDb =
        this.acc.risePeakDb === null ? frame.riseDb : Math.max(this.acc.risePeakDb, frame.riseDb);
    }
    if (frame.centroidRatio !== null) {
      this.acc.centroidRatioPeak =
        this.acc.centroidRatioPeak === null
          ? frame.centroidRatio
          : Math.max(this.acc.centroidRatioPeak, frame.centroidRatio);
      // 中央値（平滑値）算出用に、この1秒間の基準比を貯める（2026-07-18 追加）。
      this.acc.centroidRatios.push(frame.centroidRatio);
    }
  }

  /**
   * family lane（家族側ローカルマイク・声トリガーの両側化）の1フレーム分の観測値を投入する。
   * elder レーンの observeFrame とは独立に、family_rise_peak_db / family_centroid_ratio_peak の
   * ピークホールドのみを集計する（speech_ratio・gate_ratio は elder レーン専用のため対象外）。
   * 読み取り専用（rmsTrigger / centroidTrigger の内部状態には触れない）。
   */
  observeFamilyFrame(
    frame: { riseDb: number | null; centroidRatio: number | null },
    _nowMs: number
  ): void {
    if (frame.riseDb !== null) {
      this.acc.familyRisePeakDb =
        this.acc.familyRisePeakDb === null
          ? frame.riseDb
          : Math.max(this.acc.familyRisePeakDb, frame.riseDb);
    }
    if (frame.centroidRatio !== null) {
      this.acc.familyCentroidRatioPeak =
        this.acc.familyCentroidRatioPeak === null
          ? frame.centroidRatio
          : Math.max(this.acc.familyCentroidRatioPeak, frame.centroidRatio);
    }
  }

  /**
   * 家族側の表情スコア（face_score）の1サンプルを投入する（顔トリガー・Phase 2）。
   * この1秒間のピーク（face_score_peak）を集計する。読み取り専用（検知本体には触れない）。
   */
  observeFaceFrame(score: number, _nowMs: number): void {
    this.acc.faceScorePeak =
      this.acc.faceScorePeak === null
        ? score
        : Math.max(this.acc.faceScorePeak, score);
  }

  /**
   * SAMPLE_INTERVAL_MS ごとにサマリサンプルを1件確定してリングへ積む。
   * nowMs が前回 tick から SAMPLE_INTERVAL_MS 未満なら何もしない（呼び出し側は好きな頻度で
   * 呼んでよい。内部で間引く）。
   *
   * snapshot: その瞬間の rms/centroid/autoGain の現在値スナップショット
   *（ピークホールドではなく「現在値」フィールド用）。
   */
  tick(
    snapshot: {
      rms: RmsTriggerState;
      centroid: CentroidTriggerState;
      noiseFloorDb: number | null;
      autoGainDb: number | null;
      /**
       * 顔トリガーの本人ベースライン（直近10秒中央値・face_baseline 用・2026-07-18 追加）。
       * 顔検知なしの通話・既存呼び出しでは省略（null 扱い）。
       */
      faceBaseline?: number | null;
    },
    nowMs: number
  ): void {
    if (this.lastTickMs !== null && nowMs - this.lastTickMs < SAMPLE_INTERVAL_MS) {
      return;
    }
    this.lastTickMs = nowMs;

    const speechRatio =
      this.acc.totalFrames > 0 ? this.acc.speechFrames / this.acc.totalFrames : 0;
    const gateRatio =
      this.acc.totalFrames > 0 ? this.acc.gatedFrames / this.acc.totalFrames : 0;

    const sample: MeasurementSample = {
      t: this.elapsedSec(nowMs),
      rise_peak_db: this.acc.risePeakDb,
      rms_db: snapshot.rms.lastRmsDb,
      baseline_db: snapshot.rms.baselineDb,
      mode: snapshot.rms.mode,
      speech_accum_ms: snapshot.rms.speechAccumMs,
      speech_median_db: snapshot.rms.speechMedianDb,
      armed: snapshot.rms.armed,
      vad_floor_db: snapshot.rms.vadFloorDb,
      noise_floor_db: snapshot.noiseFloorDb,
      speech_ratio: speechRatio,
      centroid_hz: snapshot.centroid.lastCentroidHz,
      centroid_baseline_hz: snapshot.centroid.baselineHz,
      centroid_ratio_peak: this.acc.centroidRatioPeak,
      centroid_ratio_median: medianOf(this.acc.centroidRatios),
      auto_gain_db: snapshot.autoGainDb,
      gate_ratio: gateRatio,
      family_rise_peak_db: this.acc.familyRisePeakDb,
      family_centroid_ratio_peak: this.acc.familyCentroidRatioPeak,
      face_score_peak: this.acc.faceScorePeak,
      face_baseline: snapshot.faceBaseline ?? null,
    };

    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.shift();
    }

    this.acc = freshAccumulator();
  }

  /**
   * 発火（トリガー）の記録を開始する。発火瞬間の全スナップショットを保存する。
   * 完了は recordTriggerComplete() で追記する（photo_count・partial_save）。
   */
  recordTriggerStart(
    reason: TriggerReason,
    rmsSnapshot: RmsTriggerState,
    centroidSnapshot: CentroidTriggerState,
    autoGainDb: number | null,
    nowMs: number,
    /**
     * 発火元（声トリガーの両側化・2026-07-10 追加）。省略時は "elder"
     * （既存呼び出し・過去データとの互換）。
     */
    source: "elder" | "family" = "elder"
  ): void {
    const ev: MeasurementTriggerEvent = {
      t: this.elapsedSec(nowMs),
      type: "trigger",
      reason,
      rms: rmsSnapshot,
      centroid: centroidSnapshot,
      auto_gain_db: autoGainDb,
      photo_count: null,
      partial_save: false,
      source,
    };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
    }
    this.pendingEvent = ev;
  }

  /**
   * 直近に recordTriggerStart したイベントへ完了情報を埋める。
   * リング押し出しで pendingEvent が既に配列外へ落ちていても安全（no-op）。
   */
  recordTriggerComplete(photoCount: number, partialSave: boolean): void {
    if (!this.pendingEvent) return;
    this.pendingEvent.photo_count = photoCount;
    this.pendingEvent.partial_save = partialSave;
    this.pendingEvent = null;
  }

  /**
   * スパイク棄却（発火確認窓で破棄・2026-07-18 追加）を記録する。
   * rmsTrigger の確認窓中に非発話へ落ちて発火を破棄したときに index.ts から呼ぶ。
   */
  recordSpikeRejected(nowMs: number, source: "elder" | "family" = "elder"): void {
    const ev: MeasurementSpikeRejectedEvent = {
      t: this.elapsedSec(nowMs),
      type: "spike_rejected",
      source,
    };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
    }
  }

  /**
   * シナリオマーカー（Round 2 の集計自動化・2026-07-18 追加）を記録する。
   * 計測UIの「打刻」ボタンから呼ぶ。label は A1〜C3 または自由入力文字列。
   */
  recordMarker(label: string, nowMs: number): void {
    const ev: MeasurementMarkerEvent = {
      t: this.elapsedSec(nowMs),
      type: "marker",
      label,
    };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
    }
  }

  /** 現在の記録件数（デバッグパネル表示用）。 */
  counts(): { samples: number; events: number } {
    return { samples: this.samples.length, events: this.events.length };
  }

  /** 記録をすべてクリアする（ログクリアボタン用）。 */
  clear(): void {
    this.samples = [];
    this.events = [];
    this.acc = freshAccumulator();
    this.lastTickMs = null;
    this.pendingEvent = null;
  }

  /** エクスポート用の JSON オブジェクトを組み立てる（シリアライズ可能なプレーンオブジェクト）。 */
  toExport(nowMs = Date.now()): MeasurementLogExport {
    return {
      version: 1,
      call_id: this.callId,
      exported_at: new Date(nowMs).toISOString(),
      params: {
        rms: this.rmsParams,
        centroid: this.centroidParams,
      },
      samples: [...this.samples],
      events: [...this.events],
    };
  }
}
