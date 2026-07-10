// 委託コア②（検知キャプチャ）: RMS音圧の発火判定（純粋ロジック）
//
// 入力は rms_dB のサンプル列（約50ms間隔）。docs/detection-params.md の初期値に従う。
//   - baseline: 「静音区間ベース」で学習する平常レベル（2026-07-07 再設計）。
//     この baseline からの相対上昇（rms_rise）でスコア化する。
//   - VADゲート: 無音（簡易閾値未満）では baseline を更新せず発火もしない。
//   - 持続: 上昇状態が 150〜300ms 続いたら発火とみなす。
//   - クールダウン: 発火後 8s は次の発火をしない（2026-07-07 実測フィードバックで 4s→8s）。
//
// 【baseline の静音区間ベース再設計（2026-07-07）】
//   1. 仮初期値: 初回有声サンプルで baseline = min(サンプル値, provisionalBaselineDb=-32)。
//      自動ゲイン目標 -30dBFS と整合させた仮値。冒頭がいきなり大声でも仮値(-32)を採用するため、
//      その大声との差（rise）が大きく取れ、冒頭からでも発火できる。冒頭が静かな声ならその値を
//      採用する（min なので平常側に寄る）。
//   2. 定常区間のみ学習: rise（現在値 − baseline）が現行モードの rise 閾値以上の間は EMA 更新を
//      凍結する。盛り上がり（発話のピーク）を平常基準に取り込まない＝「静かに戻った区間」だけで
//      学習する。
//   3. 非対称追従: 更新時、baseline が上がる方向は τ=8s（ゆっくり）、下がる方向は τ=2s（速い）。
//      環境が静かになったら基準を速やかに引き下げ、うるさくなっても基準はゆっくりしか上げない。
//   ※ 旧「ウォームアップ機構（warmupMs / warmupTauMs）」は本方式に置換して廃止した。
//
// 【rise 閾値のモード依存化（2026-07-07 実測フィードバック）】
//   基準モード（改良1の Phase 1/2）によって rise 閾値を変える。仮基準（provisional）はまだ
//   baseline が安定しておらず誤発火しやすいため閾値を高く（+24dB）、発話基準（speech）は
//   baseline が話し声の実測中央値に収束済みで信頼できるため閾値を低く（+12dB）する。
//   凍結判定・持続カウント・発火判定は、いずれもその時点のモードの閾値を参照する。
//
// 【リアーム条件（2026-07-07 実測フィードバック）】
//   発火後は「rise が現行閾値未満に一度戻る」まで再発火しない（armed=false）。クールダウンとは
//   独立の AND 条件で、クールダウンが明けても声を張ったままなら再発火させない
//   （鳴りっぱなし・連続再発火の防止）。rise が閾値未満に戻ると armed=true に復帰する。
//
// 【ノイズゲート（固定 -50dB・2026-07-10 追加）】
//   vadFloorDb（動的・家族側は自動追従）とは独立に、常に -50dB を下限とする固定ゲートを
//   追加する。ゲート未満のフレームは「完全な無音」として扱い、トリガー評価（sustain加算）
//   をしない・baseline 学習に入れない・発話判定は常に false（speechAccumMs も増えない）に
//   する。vadFloorDb の自動追従がまだ収束していない通話冒頭や、クランプ変更前の設定値でも
//   「-50dB 未満には絶対反応しない」ことを保証する目的（家族側のノイズフロア推定に依存しない
//   固定の安全網）。現在フレームがゲート未満かは snapshot().gated で観測できる。
//
// このファイルは DOM / WebAudio に一切依存しない純粋ロジック（vitest で単体テストする）。
// パラメータは 1 つの設定オブジェクトに集約する。
//
// 【重要】ここに置く数値は「支給初期値」であり、精度チューニングは検収対象外
// （docs/detection-params.md・CLAUDE.md の開発ルール）。実測での調整は本実装の範囲外とする。

/** 発火要因（data-contract.md 付録 metadata の trigger_reason に対応）。 */
export type TriggerReason = "rms" | "stt" | "face" | "centroid";

/**
 * 発話フレームの中央値をローリング窓（直近 windowMs）で保持するヘルパ（2段階化・改良1/2 共通）。
 *
 * 用途は2つ:
 *   - 基準レベルの2段階化（改良1・Phase 2）: 発話フレームの音圧(dB)の中央値を基準にする。
 *   - スペクトル重心トリガー（改良2）: 発話フレームの重心(Hz)の中央値を基準にする。
 *
 * 「発話フレームのみ」を push する前提（呼び出し側でノイズフロア+ゲート判定・盛り上がり除外を行う）。
 * 窓は (値, 時刻) のペアを保持し、windowMs より古いものを落とす。中央値はソートして中央要素を採る。
 *
 * DOM / WebAudio 非依存の純粋ロジック（vitest で単体テストする）。
 */
export class RollingMedian {
  private readonly windowMs: number;
  private samples: Array<{ v: number; t: number }> = [];

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** 1サンプル（値・時刻）を追加し、窓外（windowMs より古い）を落とす。 */
  push(v: number, nowMs: number): void {
    this.samples.push({ v, t: nowMs });
    const cutoff = nowMs - this.windowMs;
    // 先頭から古いものを落とす（時刻は単調増加前提だが、安全側で filter でなく shift ループ）。
    while (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  /** 現在の窓の中央値。サンプルが無ければ null。 */
  median(): number | null {
    if (this.samples.length === 0) return null;
    const vals = this.samples.map((s) => s.v).sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    if (vals.length % 2 === 1) return vals[mid];
    return (vals[mid - 1] + vals[mid]) / 2;
  }

  /** 窓内のサンプル数（デバッグ・テスト用）。 */
  size(): number {
    return this.samples.length;
  }
}

/** RMS発火判定のパラメータ（支給初期値。チューニングは検収対象外）。 */
export interface RmsTriggerParams {
  /** サンプル間隔の想定値（ms）。持続・クールダウンの時間換算に使う。 */
  sampleIntervalMs: number;
  /**
   * baseline の仮初期値（dB・静音区間ベース再設計 2026-07-07）。
   * 初回有声サンプルで baseline = min(サンプル値, provisionalBaselineDb)。
   * 自動ゲイン目標 -30dBFS と整合させた値（-32dB）。冒頭が大声でも仮値を採用して
   * 大きな rise を作り、冒頭からでも発火できるようにする。
   */
  provisionalBaselineDb: number;
  /**
   * baseline EMA の上昇方向の時定数 τ（ms・非対称追従）。
   * baseline が上がる方向（環境がうるさくなる）は τ=8s でゆっくり追従する。
   */
  baselineTauUpMs: number;
  /**
   * baseline EMA の下降方向の時定数 τ（ms・非対称追従）。
   * baseline が下がる方向（環境が静かになる）は τ=2s で速やかに追従する。
   */
  baselineTauDownMs: number;
  /** VADゲートのしきい値（dB）。これ未満は無音とみなし baseline 更新も発火もしない。 */
  vadFloorDb: number;
  /**
   * ノイズゲート（固定・2026-07-10 追加）。これ未満は vadFloorDb（動的）の値に関わらず
   * 常に「完全な無音」として扱う（トリガー評価・baseline 学習・発話判定のいずれも行わない）。
   * 支給初期値 -50dB（固定。チューニングは検収対象外）。
   */
  noiseGateDb: number;
  /**
   * 発火とみなす baseline からの相対上昇量（dB・仮基準=provisional モード時）。
   * まだ baseline が安定していない段階のため、誤発火を避けて高めに設定する。
   * 実測で調整（検収対象外）。2026-07-07: モード依存化に伴い riseThresholdDb を分割。
   */
  riseThresholdProvisionalDb: number;
  /**
   * 発火とみなす baseline からの相対上昇量（dB・発話基準=speech モード時）。
   * baseline が発話中央値に収束済みで信頼できるため、仮基準より低く（感度高く）設定する。
   * 実測で調整（検収対象外）。
   */
  riseThresholdSpeechDb: number;
  /** 発火に必要な上昇の持続時間（ms）。150〜300ms（初期値150ms）。 */
  sustainMs: number;
  /** 発火後のクールダウン（ms）。2026-07-07 実測フィードバックにより 4s→8s。 */
  cooldownMs: number;

  // --- 基準レベルの2段階化（改良1・発話基準）-------------------------------
  /**
   * 発話とみなすゲート（ノイズフロア + このマージン dB 以上のフレームを発話とみなす）。
   * ノイズフロア推定は audioPipeline から setNoiseFloorDb で反映される。
   * 定数 SPEECH_GATE_DB=8（ノイズフロア +8dB 以上を発話とする）。
   */
  speechGateDb: number;
  /**
   * Phase 1 → Phase 2 へ切り替える発話累計時間（ms）。
   * 発話フレームの累計がこの値に達したら「発話基準（中央値）」モードへ移行する。
   * 定数 SPEECH_ACCUM_MS=5000（5秒）。
   */
  speechAccumMs: number;
  /**
   * 発話フレーム音圧の中央値を採るローリング窓（ms）。
   * 定数 MEDIAN_WINDOW_MS=20000（直近20秒）。
   */
  medianWindowMs: number;
  /**
   * Phase 2 の基準反映スルーレート（dB/秒）。
   * 発話中央値が急変しても baseline は 1 秒あたりこの量までしか動かさない（急変防止）。
   * 定数 BASELINE_SLEW_DB_PER_SEC=1（±1dB/秒）。
   */
  baselineSlewDbPerSec: number;
}

/**
 * 支給初期値（docs/detection-params.md）。
 * ※ これらの数値のチューニングは検収対象外（実測で調整する前提）。
 */
export const DEFAULT_RMS_PARAMS: RmsTriggerParams = {
  sampleIntervalMs: 50,
  // baseline 仮初期値（静音区間ベース再設計 2026-07-07）。自動ゲイン目標 -30dBFS と整合。
  provisionalBaselineDb: -32,
  // 非対称追従: 上昇方向はゆっくり（τ=8s）、下降方向は速い（τ=2s）。
  baselineTauUpMs: 8000, // 上がる方向 τ=8s（うるさくなっても基準はゆっくり上げる）
  baselineTauDownMs: 2000, // 下がる方向 τ=2s（静かに戻ったら基準を速やかに下げる）
  vadFloorDb: -55, // これ未満は無音（VADゲート・簡易閾値）
  // ノイズゲート（固定 -50dB・2026-07-10 追加）。vadFloorDb の自動追従に関わらず、
  // これ未満は絶対に「無音」として扱う（固定の安全網）。
  noiseGateDb: -50,
  // rise 閾値のモード依存化（2026-07-07 実測フィードバック）。
  // 仮基準（provisional）は baseline がまだ安定していないため高め（+24dB）、
  // 発話基準（speech）は baseline が発話中央値に収束済みで信頼できるため低め（+12dB）。
  riseThresholdProvisionalDb: 24,
  riseThresholdSpeechDb: 12,
  // 発火に必要な上昇の持続。150〜300ms の下限（発火を出やすくする）。
  // 2026-07-05 オーナー実測フィードバックにより 200ms → 150ms。
  sustainMs: 150,
  // 2026-07-07 実測フィードバックにより 4s → 8s（RMS・STT・重心で共有）。
  cooldownMs: 8000,
  // 基準レベルの2段階化（改良1・発話基準）。
  speechGateDb: 8, // ノイズフロア +8dB 以上を発話とみなす（SPEECH_GATE_DB）
  speechAccumMs: 5000, // 発話累計5秒で Phase 2（発話基準）へ切替（SPEECH_ACCUM_MS）
  medianWindowMs: 20000, // 発話フレームの中央値ローリング窓20秒（MEDIAN_WINDOW_MS）
  baselineSlewDbPerSec: 1, // Phase 2 基準反映スルーレート ±1dB/秒（BASELINE_SLEW_DB_PER_SEC）
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
  /** ノイズゲート（固定・2026-07-10 追加）のしきい値（dB）。支給初期値 -50。デバッグ表示用。 */
  noiseGateDb: number;
  /**
   * 現在フレームがノイズゲート未満（完全な無音）か（2026-07-10 追加）。
   * true の間は baseline 学習・sustain 加算・発話判定のいずれも行わない。デバッグ表示用。
   */
  gated: boolean;
  /**
   * baseline 学習が凍結中か（静音区間ベース再設計 2026-07-07）。
   * 直近の有声サンプルの rise（現在値 − baseline）が現行モードの rise 閾値以上で、盛り上がりを
   * 平常基準に取り込まないよう EMA 更新を止めている状態。デバッグパネルの「凍結中」表示用。
   */
  frozen: boolean;
  /**
   * 現在モードの rise 閾値（dB）。provisional=+24dB／speech=+12dB（2026-07-07）。
   * デバッグパネルの「パラメータ現在値」表示用（モード連動）。
   */
  riseThresholdDb: number;
  /**
   * リアーム済み（再発火可能）か（2026-07-07 追加）。
   * 発火直後は false になり、rise が現行閾値未満に一度戻ると true に復帰する。
   * クールダウンとは独立の AND 条件（鳴りっぱなし・連続再発火の防止）。デバッグパネル用。
   */
  armed: boolean;

  // --- 基準レベルの2段階化（改良1・発話基準）-------------------------------
  /**
   * 現在の基準モード（改良1）。
   * "provisional"=Phase 1（仮初期値 -32・静音区間ベースの EMA 学習）／
   * "speech"=Phase 2（発話フレーム中央値・スルー制限付き）。
   */
  mode: "provisional" | "speech";
  /** 発話（ノイズフロア+8dB 以上）と判定したフレームの累計時間（ms）。5秒で Phase 2 へ。 */
  speechAccumMs: number;
  /** Phase 2 の発話中央値（直近20秒・dB）。窓が空なら null。デバッグ表示用。 */
  speechMedianDb: number | null;
}

/**
 * RMS音圧の発火判定器。
 *
 * push(rmsDb, nowMs) を約50ms間隔で呼ぶ。発火条件を満たしたら RmsTriggerEvent を返す
 * （満たさなければ null）。時刻は呼び出し側が渡す（テスト容易性のため内部で時計を持たない）。
 */
export class RmsTrigger {
  private readonly p: RmsTriggerParams;

  // baseline（静音区間ベースで学習する平常レベル）。無音では更新しない。初期は最初の有声
  // サンプルで確定する（仮初期値 -32 との min）。以降は定常区間のみ非対称 EMA で追従する。
  private baselineDb: number | null = null;
  // 上昇状態が続いている累積時間（ms）。
  private sustainedMs = 0;
  // クールダウン終了時刻（ms）。これ未満の時刻では発火しない。
  private cooldownUntilMs = 0;
  // 直近サンプルの時刻（サンプル間隔の実測に使う。無ければ params.sampleIntervalMs）。
  private lastTimeMs: number | null = null;
  private lastRmsDb: number | null = null;
  private triggerCount = 0;
  // baseline 学習が凍結中か（静音区間ベース再設計）。直近サンプルの rise が現行モードの
  // rise 閾値以上のとき true。盛り上がり区間の値を平常基準に取り込まないよう EMA 更新を止める。
  private frozen = false;
  // リアーム済み（再発火可能）か（2026-07-07 追加）。発火直後は false になり、
  // rise が現行閾値未満に一度戻ると true に復帰する。クールダウンとは独立の AND 条件。
  private armed = true;
  // 現在フレームがノイズゲート（固定・2026-07-10 追加）未満か。observability 用。
  private gated = false;

  // --- 基準レベルの2段階化（改良1・発話基準）--------------------------------
  // 発話ゲート用のノイズフロア推定（audioPipeline から setNoiseFloorDb で反映）。
  // 未設定（null）の間は vadFloorDb を発話ゲートの代替に使う（床＝ノイズ+8dB のため等価）。
  private noiseFloorDb: number | null = null;
  // 発話（ノイズフロア+speechGateDb 以上）と判定したフレームの累計時間（ms）。
  private speechAccumMs = 0;
  // 発話フレーム音圧の中央値ローリング窓（直近 medianWindowMs）。
  private readonly speechMedian: RollingMedian;
  // 現在の基準モード（provisional=Phase1 / speech=Phase2）。
  private mode: "provisional" | "speech" = "provisional";

  constructor(params: Partial<RmsTriggerParams> = {}) {
    this.p = { ...DEFAULT_RMS_PARAMS, ...params };
    this.speechMedian = new RollingMedian(this.p.medianWindowMs);
  }

  /**
   * 発話ゲート用のノイズフロア推定を反映する（改良1）。
   * audioPipeline がノイズフロアを推定して定期的に渡す。発話判定「ノイズ+speechGateDb 以上」に使う。
   */
  setNoiseFloorDb(db: number): void {
    this.noiseFloorDb = db;
  }

  /**
   * 発話ゲートのしきい値（dB）。ノイズフロア + speechGateDb。
   * ノイズフロア未設定の間は vadFloorDb を代替に使う（床＝ノイズ+8dB のため）。
   */
  private speechGateThresholdDb(): number {
    if (this.noiseFloorDb !== null) {
      return this.noiseFloorDb + this.p.speechGateDb;
    }
    return this.p.vadFloorDb;
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
   * 現在モードの rise 閾値（dB）。モード依存化（2026-07-07）。
   * provisional（仮基準）= riseThresholdProvisionalDb（+24dB）／
   * speech（発話基準）= riseThresholdSpeechDb（+12dB）。
   * 凍結判定・持続カウント・発火判定はすべてこの値を参照する。
   */
  private currentRiseThresholdDb(): number {
    return this.mode === "speech"
      ? this.p.riseThresholdSpeechDb
      : this.p.riseThresholdProvisionalDb;
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

    // --- ノイズゲート（固定・2026-07-10 追加）: vadFloorDb の値に関わらず、
    // これ未満は常に「完全な無音」として扱う（sustain・baseline学習・発話判定のいずれもしない）。
    this.gated = rmsDb < this.p.noiseGateDb;

    // --- VADゲート（動的）／ノイズゲート（固定）: 無音は baseline を更新せず、
    // 持続もリセットして即 return -------------------------------------------
    // 無音（rise が評価不能）は「声が収まった」とみなしてリアームする（2026-07-07 追加）。
    // 大声の直後に静寂に戻るケースで、次の有声発話まで再発火不能のまま固まらないようにする。
    if (this.gated || rmsDb < this.p.vadFloorDb) {
      this.sustainedMs = 0;
      this.armed = true;
      return null;
    }

    // --- baseline 更新: 静音区間ベース（2026-07-07 再設計）---------------------
    if (this.baselineDb === null) {
      // 初回の有声サンプルで baseline を確定する。
      // 【仮初期値】baseline = min(サンプル値, provisionalBaselineDb=-32)。
      // 冒頭が大声（例 -15dB）でも仮値 -32 を採用 → 大きな rise を作り冒頭から発火できる。
      // 冒頭が静かな声（例 -40dB）ならその値を採用（min なので平常側に寄る）。
      this.baselineDb = Math.min(rmsDb, this.p.provisionalBaselineDb);
    }

    // rise は「現在の baseline」との差で評価する（この後の凍結判定にも使う）。
    const rise = rmsDb - this.baselineDb;
    // 現行モード（provisional/speech）の rise 閾値（2026-07-07 モード依存化）。
    const riseThresholdDb = this.currentRiseThresholdDb();

    // 【定常区間のみ学習】rise が現行閾値以上の間は EMA 更新を凍結する
    //（盛り上がりのピークを平常基準に取り込まない）。凍結解除は rise が閾値未満に戻ったとき。
    this.frozen = rise >= riseThresholdDb;

    // 【リアーム（2026-07-07 追加）】rise が現行閾値未満に戻ったら再発火可能にする。
    // クールダウンとは独立の AND 条件（鳴りっぱなし・連続再発火の防止）。
    if (rise < riseThresholdDb) {
      this.armed = true;
    }

    // --- 基準レベルの2段階化（改良1・発話基準）-------------------------------
    // このサンプルが「発話フレーム」か（ノイズフロア +speechGateDb 以上）。
    // 発話累計の積算・中央値窓への投入・Phase 2 移行判定に使う。
    const isSpeech = rmsDb >= this.speechGateThresholdDb();
    if (isSpeech) {
      this.speechAccumMs += dt;
      // rise ≥ 閾値の盛り上がり（発話ピーク）は中央値窓に入れない
      //（平常の話し声レベルを基準にするため、興奮のピークで基準を吊り上げない）。
      if (!this.frozen) {
        this.speechMedian.push(rmsDb, nowMs);
      }
    }
    // Phase 1 → Phase 2 の切替（発話累計が speechAccumMs 到達で speech モードへ）。
    if (this.mode === "provisional" && this.speechAccumMs >= this.p.speechAccumMs) {
      this.mode = "speech";
    }

    if (this.mode === "speech") {
      // 【Phase 2】基準 = 発話フレームの中央値（直近 medianWindowMs）。
      // 中央値が急変しても baseline はスルー制限（±baselineSlewDbPerSec/秒）で追従する。
      const med = this.speechMedian.median();
      if (med !== null) {
        const maxStepDb = (this.p.baselineSlewDbPerSec * dt) / 1000;
        const delta = med - this.baselineDb;
        const step = Math.max(-maxStepDb, Math.min(maxStepDb, delta));
        this.baselineDb = this.baselineDb + step;
      }
      // 窓は以後も更新し続ける（中央値が最新の発話レベルへ追随する）。
    } else if (!this.frozen) {
      // 【Phase 1】静音区間ベースの非対称 EMA（従来どおり）。
      // baseline が下がる方向（環境が静かになる）は τ=2s で速く、
      // 上がる方向（うるさくなる）は τ=8s でゆっくり追従する。
      const tau =
        rmsDb < this.baselineDb
          ? this.p.baselineTauDownMs // 下降: 速い（τ=2s）
          : this.p.baselineTauUpMs; // 上昇: ゆっくり（τ=8s）
      const alpha = Math.min(1, dt / tau);
      this.baselineDb = this.baselineDb + alpha * (rmsDb - this.baselineDb);
    }

    // --- 持続カウント: 上昇しきい値を超えている間だけ積算 -----------------------
    if (rise >= riseThresholdDb) {
      this.sustainedMs += dt;
    } else {
      this.sustainedMs = 0;
    }

    // --- クールダウン中は発火しない（baseline / 持続の更新は続ける） ------------
    if (nowMs < this.cooldownUntilMs) {
      return null;
    }

    // --- リアーム未済（前回発火から rise が閾値未満へ戻っていない）は発火しない ---
    // （2026-07-07 追加。クールダウンと AND。鳴りっぱなし・連続再発火の防止）。
    if (!this.armed) {
      return null;
    }

    // --- 発火判定: 持続が閾値に達したら発火 -------------------------------------
    if (this.sustainedMs >= this.p.sustainMs) {
      this.cooldownUntilMs = nowMs + this.p.cooldownMs;
      this.sustainedMs = 0;
      this.triggerCount += 1;
      this.armed = false; // リアーム解除: rise が閾値未満に戻るまで再発火しない
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
      noiseGateDb: this.p.noiseGateDb,
      gated: this.gated,
      frozen: this.frozen,
      riseThresholdDb: this.currentRiseThresholdDb(),
      armed: this.armed,
      mode: this.mode,
      speechAccumMs: this.speechAccumMs,
      speechMedianDb: this.speechMedian.median(),
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
   * - gated: 直近サンプルがノイズゲート（固定・2026-07-10 追加）未満だったか。
   *
   * 発火判定（push）とは独立の読み取り専用メソッド（内部状態は変えない）。
   */
  sample(): { rmsDb: number | null; rmsRise: number; gated: boolean } {
    const rmsDb = this.lastRmsDb;
    let rmsRise = 0;
    if (rmsDb !== null && this.baselineDb !== null) {
      rmsRise = rmsDb - this.baselineDb;
    }
    return { rmsDb, rmsRise, gated: this.gated };
  }
}
