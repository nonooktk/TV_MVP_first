// 委託コア①（通話基盤）: マイク入力の自動ゲイン（Zoom 風のゆっくり正規化・純粋ロジック）
//
// 高齢者側（送信側・uid=2）のマイク音声を、目標発話レベルへ向けて**ゆっくり**正規化する。
// AGC（Agora/ブラウザの自動ゲイン制御）は据え置きで無効のまま（急激な音量変化は検知の
// 相対上昇トリガーを壊すため）。代わりに、有声区間の平均音圧を数秒スケールで EMA 追跡し、
// 目標レベルとの差からゲインを算出する。ゲインは 2 秒ごとに、±2dB/更新 のスルーレートで
// じわじわ動かす（Zoom のように「気づかないうちに音量が揃う」挙動）。
//
// このファイルは WebAudio / DOM に一切依存しない純粋ロジック（vitest で単体テスト可能）。
// 実際の GainNode への適用は agoraCall.ts が targetGainDb() を dB→倍率換算して行う。

/** 自動ゲインのパラメータ（支給仕様準拠。チューニングは検収対象外）。 */
export interface SlowGainParams {
  /** 目標の発話レベル（dBFS 定数）。有声 RMS の EMA をここへ寄せる。 */
  targetDbfs: number;
  /** 有声 RMS の EMA 時定数 τ（ms）。約3秒でゆっくり追跡する。 */
  emaTauMs: number;
  /** ゲインを更新する間隔（ms）。2 秒ごと。 */
  updateIntervalMs: number;
  /** 1 更新あたりのゲイン変化上限（dB）。±2dB/更新（急変させない）。 */
  slewDbPerUpdate: number;
  /** 適用ゲインの下限（dB）。0（減衰はしない＝素通し以上）。 */
  minGainDb: number;
  /** 適用ゲインの上限（dB）。+18dB。 */
  maxGainDb: number;
  /**
   * 有声とみなす下限（dBFS）。これ未満のサンプルは無音として EMA 更新に使わない
   * （無音を平均に混ぜると EMA が下振れしてゲインが張り付くのを防ぐ）。
   */
  voicedFloorDbfs: number;
}

/**
 * 支給初期値。
 * - 目標発話レベル -30dBFS（brief 指定の定数）。
 * - EMA τ=3s・更新2秒ごと・±2dB/更新・クランプ 0〜+18dB。
 */
export const DEFAULT_SLOW_GAIN_PARAMS: SlowGainParams = {
  targetDbfs: -30,
  emaTauMs: 3000,
  updateIntervalMs: 2000,
  slewDbPerUpdate: 2,
  minGainDb: 0,
  maxGainDb: 18,
  voicedFloorDbfs: -55, // rmsTrigger の VAD 床と同水準（無音を EMA に混ぜない）
};

/** 観測用スナップショット（?debug=1 のミニ表示に使う）。 */
export interface SlowGainState {
  /** 有声 RMS の EMA（dBFS）。まだ有声サンプルが無ければ null。 */
  emaDbfs: number | null;
  /** 現在適用中のゲイン（dB）。 */
  currentGainDb: number;
  /** 直近サンプルの測定レベル（dBFS）。 */
  lastRmsDbfs: number | null;
}

/**
 * ゆっくり正規化するゲイン計算器（純粋ロジック）。
 *
 * 使い方:
 *   const n = new SlowGainNormalizer();
 *   // 約50ms間隔で測定した dBFS を投入（無声も渡してよい＝内部で有声判定する）。
 *   n.pushSample(rmsDbfs, nowMs);
 *   // GainNode に反映するのはこの値（dB）。適用側が dB→倍率へ換算する。
 *   const gainDb = n.targetGainDb();
 *
 * 設計:
 * - EMA は「有声サンプルのみ」で更新する（無音はスキップ）。
 * - ゲインは updateIntervalMs ごとにだけ再計算し、目標ゲイン（target - EMA）へ向けて
 *   ±slewDbPerUpdate ずつ近づける（スルーレート制限）。→ 急変しない。
 * - 目標ゲインと適用ゲインはともに [minGainDb, maxGainDb] にクランプする。
 */
export class SlowGainNormalizer {
  private readonly p: SlowGainParams;

  private emaDbfs: number | null = null;
  private lastRmsDbfs: number | null = null;
  private lastSampleMs: number | null = null;
  private currentGainDb = 0;
  private lastUpdateMs: number | null = null;

  constructor(params: Partial<SlowGainParams> = {}) {
    this.p = { ...DEFAULT_SLOW_GAIN_PARAMS, ...params };
    // 初期ゲインは 0dB（素通し）にクランプ範囲内で寄せる。
    this.currentGainDb = this.clampGain(0);
  }

  /**
   * 1 サンプルを投入する（約50ms間隔）。有声なら EMA を更新し、更新間隔に達していれば
   * ゲインをスルーレート制限つきで再計算する。
   * @param rmsDbfs このサンプルの音圧（dBFS）
   * @param nowMs 現在時刻（ms・単調増加。テストでは擬似時刻を渡す）
   */
  pushSample(rmsDbfs: number, nowMs: number): void {
    this.lastRmsDbfs = rmsDbfs;

    // サンプル間隔（実測 dt。初回は EMA を確定値として置く）。
    const dt =
      this.lastSampleMs === null
        ? this.p.emaTauMs // 初回は α=1 相当にはせず、下で確定代入する
        : Math.max(0, nowMs - this.lastSampleMs);
    this.lastSampleMs = nowMs;

    // 有声サンプルのみ EMA を更新（無音は平均に混ぜない）。
    if (rmsDbfs >= this.p.voicedFloorDbfs) {
      if (this.emaDbfs === null) {
        this.emaDbfs = rmsDbfs; // 初回有声サンプルで確定
      } else {
        const alpha = Math.min(1, dt / this.p.emaTauMs);
        this.emaDbfs = this.emaDbfs + alpha * (rmsDbfs - this.emaDbfs);
      }
    }

    // 更新間隔に達したらゲインを再計算（スルーレート制限つき）。
    if (this.lastUpdateMs === null) {
      this.lastUpdateMs = nowMs;
      return;
    }
    if (nowMs - this.lastUpdateMs >= this.p.updateIntervalMs) {
      this.lastUpdateMs = nowMs;
      this.recomputeGain();
    }
  }

  /** 目標ゲイン（target - EMA）へ ±slew でにじり寄せる。EMA 未確定なら現状維持。 */
  private recomputeGain(): void {
    if (this.emaDbfs === null) return;
    const desiredGainDb = this.clampGain(this.p.targetDbfs - this.emaDbfs);
    const delta = desiredGainDb - this.currentGainDb;
    const step = Math.max(
      -this.p.slewDbPerUpdate,
      Math.min(this.p.slewDbPerUpdate, delta)
    );
    this.currentGainDb = this.clampGain(this.currentGainDb + step);
  }

  private clampGain(db: number): number {
    return Math.max(this.p.minGainDb, Math.min(this.p.maxGainDb, db));
  }

  /** 現在適用すべきゲイン（dB）。GainNode 適用側が dB→倍率へ換算する。 */
  targetGainDb(): number {
    return this.currentGainDb;
  }

  /** dB→線形倍率（適用側の利便のため）。gain = 10^(dB/20)。 */
  targetGainLinear(): number {
    return dbToLinear(this.currentGainDb);
  }

  /** 観測用スナップショット（?debug=1 のミニ表示）。 */
  snapshot(): SlowGainState {
    return {
      emaDbfs: this.emaDbfs,
      currentGainDb: this.currentGainDb,
      lastRmsDbfs: this.lastRmsDbfs,
    };
  }
}

/** dB → 線形倍率。 */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}
