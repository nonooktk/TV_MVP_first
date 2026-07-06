// 委託コア②（検知キャプチャ）: RMS音圧の発火判定（純粋ロジック）
//
// 入力は rms_dB のサンプル列（約50ms間隔）。docs/detection-params.md の初期値に従う。
//   - baseline: 緩いEMA（τ=3〜5s）。この baseline からの相対上昇（rms_rise）でスコア化する。
//   - VADゲート: 無音（簡易閾値未満）では baseline を更新せず発火もしない。
//   - 持続: 上昇状態が 150〜300ms 続いたら発火とみなす。
//   - クールダウン: 発火後 3〜5s は次の発火をしない。
//
// このファイルは DOM / WebAudio に一切依存しない純粋ロジック（vitest で単体テストする）。
// パラメータは 1 つの設定オブジェクトに集約する。
//
// 【重要】ここに置く数値は「支給初期値」であり、精度チューニングは検収対象外
// （docs/detection-params.md・CLAUDE.md の開発ルール）。実測での調整は本実装の範囲外とする。

/** 発火要因（data-contract.md 付録 metadata の trigger_reason に対応）。 */
export type TriggerReason = "rms" | "stt" | "face";

/** RMS発火判定のパラメータ（支給初期値。チューニングは検収対象外）。 */
export interface RmsTriggerParams {
  /** サンプル間隔の想定値（ms）。持続・クールダウンの時間換算に使う。 */
  sampleIntervalMs: number;
  /** baseline EMA の時定数 τ（ms）。緩いEMA=3〜5s の範囲（初期値4s）。 */
  baselineTauMs: number;
  /** VADゲートのしきい値（dB）。これ未満は無音とみなし baseline 更新も発火もしない。 */
  vadFloorDb: number;
  /** 発火とみなす baseline からの相対上昇量（dB）。実測で調整（検収対象外）。 */
  riseThresholdDb: number;
  /** 発火に必要な上昇の持続時間（ms）。150〜300ms（初期値200ms）。 */
  sustainMs: number;
  /** 発火後のクールダウン（ms）。3〜5s（初期値4s）。 */
  cooldownMs: number;
  /**
   * baseline ウォームアップの時定数 τ（ms・修正4）。
   * 通話冒頭の有声サンプル累計が warmupMs に達するまでは baselineTauMs ではなくこの速い
   * τ で順応させ、基準を数秒で平常側へ引き下げる（コールドスタート緩和）。初期値1s。
   */
  warmupTauMs: number;
  /**
   * ウォームアップを適用する有声サンプルの累計時間（ms・修正4）。
   * 「最初の有声3秒間だけ τ=warmupTauMs、その後は通常運転 τ=baselineTauMs」を実現する。
   * 初期値3s。
   */
  warmupMs: number;
}

/**
 * 支給初期値（docs/detection-params.md）。
 * ※ これらの数値のチューニングは検収対象外（実測で調整する前提）。
 */
export const DEFAULT_RMS_PARAMS: RmsTriggerParams = {
  sampleIntervalMs: 50,
  baselineTauMs: 4000, // τ=4s（3〜5sの中央）
  vadFloorDb: -55, // これ未満は無音（VADゲート・簡易閾値）
  // baseline比 +6dB で「声を張った」とみなす。
  // 2026-07-05 オーナー実測フィードバックにより +8dB → +6dB（発火が渋いため感度UP）。
  riseThresholdDb: 6,
  // 発火に必要な上昇の持続。150〜300ms の下限（発火を出やすくする）。
  // 2026-07-05 オーナー実測フィードバックにより 200ms → 150ms。
  sustainMs: 150,
  cooldownMs: 4000, // 3〜5s の中央（据え置き）
  // ウォームアップ（修正4）: 最初の有声3秒間だけ τ=1s で速く順応させる。
  // 通話冒頭にいきなり叫んだケースでも、基準が数秒で平常側へ降りてきて、
  // 追加の発話で発火できるようにする。以降は τ=baselineTauMs(4s) の通常運転。
  warmupTauMs: 1000, // ウォームアップ中の速い τ=1s
  warmupMs: 3000, // 有声サンプル累計3秒までウォームアップ
};

/** 発火時に外へ渡す情報（metadata の rms_db / rms_rise / trigger_reason の素） */
export interface RmsTriggerEvent {
  /** 発火時の音圧（dB）。metadata.rms_db に対応。 */
  rmsDb: number;
  /** baseline比の上昇量（dB）。metadata.rms_rise に対応。 */
  rmsRise: number;
  /** 発火要因。RMSトリガーなので常に "rms"。metadata.trigger_reason に対応。 */
  reason: TriggerReason;
  /** 発火時点の baseline（dB）。デバッグ・観測用。 */
  baselineDb: number;
}

/** 観測用の内部状態スナップショット（window.__detection.state で参照する）。 */
export interface RmsTriggerState {
  baselineDb: number | null;
  lastRmsDb: number | null;
  sustainedMs: number;
  inCooldown: boolean;
  triggerCount: number;
  /** baseline 比の相対上昇量（dB）。baseline/サンプル未確立は null。デバッグ表示用。 */
  riseDb: number | null;
  /** クールダウン残り（ms）。0 なら発火可能。デバッグ表示用。 */
  cooldownRemainingMs: number;
  /** 現在の VAD 床（dB）。audioPipeline のノイズフロア推定で動的更新される。デバッグ表示用。 */
  vadFloorDb: number;
  /**
   * baseline ウォームアップ中か（有声サンプル累計が warmupMs 未満＝速い τ で順応中）。
   * デバッグパネルの warmup 表示用。
   */
  inWarmup: boolean;
}

/**
 * RMS音圧の発火判定器。
 *
 * push(rmsDb, nowMs) を約50ms間隔で呼ぶ。発火条件を満たしたら RmsTriggerEvent を返す
 * （満たさなければ null）。時刻は呼び出し側が渡す（テスト容易性のため内部で時計を持たない）。
 */
export class RmsTrigger {
  private readonly p: RmsTriggerParams;

  // baseline（緩いEMA）。無音では更新しない。初期は最初の有声サンプルで確定する。
  private baselineDb: number | null = null;
  // 上昇状態が続いている累積時間（ms）。
  private sustainedMs = 0;
  // クールダウン終了時刻（ms）。これ未満の時刻では発火しない。
  private cooldownUntilMs = 0;
  // 直近サンプルの時刻（サンプル間隔の実測に使う。無ければ params.sampleIntervalMs）。
  private lastTimeMs: number | null = null;
  private lastRmsDb: number | null = null;
  private triggerCount = 0;
  // 有声サンプルの累計時間（ms・修正4）。warmupMs 未満の間だけ速い τ で順応する。
  private voicedMs = 0;

  constructor(params: Partial<RmsTriggerParams> = {}) {
    this.p = { ...DEFAULT_RMS_PARAMS, ...params };
  }

  /**
   * VAD 床（vadFloorDb）を動的に更新する（家族側 VAD 床の自動化・item 12）。
   *
   * audioPipeline がノイズフロアを推定し「床＝ノイズ+8dB・[-70,-45] クランプ」を定期反映する。
   * baseline や persistence など他の内部状態は変えない（床だけを差し替える）。
   */
  setVadFloorDb(db: number): void {
    this.p.vadFloorDb = db;
  }

  /** 現在の VAD 床（dB）。 */
  vadFloorDb(): number {
    return this.p.vadFloorDb;
  }

  /**
   * 1サンプルを投入する。発火したら RmsTriggerEvent、しなければ null。
   * @param rmsDb このサンプルの音圧（dB）
   * @param nowMs 現在時刻（ms・単調増加。テストでは擬似時刻を渡す）
   */
  push(rmsDb: number, nowMs: number): RmsTriggerEvent | null {
    // サンプル間隔（実測 dt。初回や巻き戻りは想定値でクランプ）。
    const dt =
      this.lastTimeMs === null
        ? this.p.sampleIntervalMs
        : Math.max(0, Math.min(nowMs - this.lastTimeMs, this.p.sampleIntervalMs * 4));
    this.lastTimeMs = nowMs;
    this.lastRmsDb = rmsDb;

    // --- VADゲート: 無音は baseline を更新せず、持続もリセットして即 return -------
    if (rmsDb < this.p.vadFloorDb) {
      this.sustainedMs = 0;
      return null;
    }

    // --- baseline（緩いEMA）更新: 有声サンプルのみ -----------------------------
    if (this.baselineDb === null) {
      // 初回の有声サンプルで baseline を確定（立ち上がりで誤発火しないため）。
      // ※ この「初回有声サンプル=baseline 確定」の挙動はウォームアップ導入後も維持する。
      this.baselineDb = rmsDb;
    } else {
      // EMA: α = dt / τ（τが大きいほど緩やか）。
      // 【修正4: baseline ウォームアップ】
      // 有声サンプルの累計（voicedMs）が warmupMs 未満の間は速い τ=warmupTauMs(1s) で
      // 順応させ、通話冒頭の高い立ち上がり（いきなり叫ぶ等）から基準を数秒で平常側へ
      // 引き下げる。累計が warmupMs 以上になったら通常運転 τ=baselineTauMs(4s) に戻す。
      const tau =
        this.voicedMs < this.p.warmupMs
          ? this.p.warmupTauMs
          : this.p.baselineTauMs;
      const alpha = Math.min(1, dt / tau);
      this.baselineDb = this.baselineDb + alpha * (rmsDb - this.baselineDb);
    }
    // 有声サンプルの累計を進める（VADゲート通過後のみここに到達する）。
    this.voicedMs += dt;

    const rise = rmsDb - this.baselineDb;

    // --- 持続カウント: 上昇しきい値を超えている間だけ積算 -----------------------
    if (rise >= this.p.riseThresholdDb) {
      this.sustainedMs += dt;
    } else {
      this.sustainedMs = 0;
    }

    // --- クールダウン中は発火しない（baseline / 持続の更新は続ける） ------------
    if (nowMs < this.cooldownUntilMs) {
      return null;
    }

    // --- 発火判定: 持続が閾値に達したら発火 -------------------------------------
    if (this.sustainedMs >= this.p.sustainMs) {
      this.cooldownUntilMs = nowMs + this.p.cooldownMs;
      this.sustainedMs = 0;
      this.triggerCount += 1;
      return {
        rmsDb,
        rmsRise: rise,
        reason: "rms",
        baselineDb: this.baselineDb,
      };
    }

    return null;
  }

  /** 観測用の内部状態スナップショット。 */
  snapshot(nowMs: number): RmsTriggerState {
    const riseDb =
      this.lastRmsDb !== null && this.baselineDb !== null
        ? this.lastRmsDb - this.baselineDb
        : null;
    return {
      baselineDb: this.baselineDb,
      lastRmsDb: this.lastRmsDb,
      sustainedMs: this.sustainedMs,
      inCooldown: nowMs < this.cooldownUntilMs,
      triggerCount: this.triggerCount,
      riseDb,
      cooldownRemainingMs: Math.max(0, this.cooldownUntilMs - nowMs),
      vadFloorDb: this.p.vadFloorDb,
      inWarmup: this.voicedMs < this.p.warmupMs,
    };
  }

  /**
   * その時点の音圧サンプル（rms_db / rms_rise）を返す（コマごと採点用）。
   *
   * 連写の各ショット時点でこれを呼び、写真ごとの metadata.rms_db / rms_rise に記録する。
   * これにより無表情環境（face_score が全0）でも、連写内で音圧の自然な差がつく。
   *
   * - rmsDb: 直近サンプルの音圧（dB）。まだサンプルが無ければ null。
   * - rmsRise: baseline からの相対上昇量（dB）。baseline 未確立なら 0。
   *
   * 発火判定（push）とは独立の読み取り専用メソッド（内部状態は変えない）。
   */
  sample(): { rmsDb: number | null; rmsRise: number } {
    const rmsDb = this.lastRmsDb;
    let rmsRise = 0;
    if (rmsDb !== null && this.baselineDb !== null) {
      rmsRise = rmsDb - this.baselineDb;
    }
    return { rmsDb, rmsRise };
  }
}
