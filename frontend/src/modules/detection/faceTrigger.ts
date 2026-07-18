// 委託コア②（検知キャプチャ）: 顔トリガー（家族側の表情スコア発火・純粋ロジック・Phase 2）
//
// 顔検知の家族側化（Phase 2）に伴い新設。家族側ローカルカメラ（孫が映る側）の表情スコア
// （face_score・既存の facePipeline が算出する mouthSmile 系 blendshape 平均 0〜1）を
// 音圧（RMS）・声色（重心）とは独立の軸で発火させる。
//
// 設計（承認済み仕様・docs/detection-params.md）:
//   - 入力は facePipeline.score()（0〜1）を約 sampleIntervalMs 間隔で push する。
//   - 発火条件（2026-07-18 Round 1 実測に基づき「変化」化）:
//       score >= scoreThreshold（絶対 0.85）**かつ** score - baseline >= riseDelta（上昇 0.4）
//       を sustainMs（500ms）持続。
//     絶対値だけだと「普通の笑顔」でも 0.7 を超えて過検出したため、**本人ベースライン比の
//     上昇**を AND 条件に加えた（無表情→笑顔の“変化”を捉える）。
//   - ベースライン: 顔スコアの直近 baselineWindowMs（10秒）ローリング中央値（RollingMedian 流用）。
//   - リアーム: 発火後は「スコアが scoreThreshold 未満に一度戻る」まで再発火しない（armed=false→true）。
//   - クールダウンは持たない（上位 handleTrigger の全系統共有クールダウン8秒に委ねる。
//     RMS/STT/重心/顔・elder/family のどれが発火しても横断的に次の8秒を抑止する）。
//
// DOM / WebAudio 非依存の純粋ロジック（vitest で単体テストする）。
//
// 【重要】ここに置く数値は「支給初期値」であり、精度チューニングは検収対象外
// （docs/detection-params.md・CLAUDE.md の開発ルール）。

import { RollingMedian } from "./rmsTrigger";

/** 顔トリガーのパラメータ（支給初期値。チューニングは検収対象外）。 */
export interface FaceTriggerParams {
  /** サンプル間隔の想定値（ms）。持続の時間換算に使う。 */
  sampleIntervalMs: number;
  /**
   * 発火とみなす表情スコアの**絶対閾値**（0〜1・faceTriggerScore）。
   * face_score がこの値以上であることが発火の必要条件（本人比の上昇 riseDelta と AND）。
   * 2026-07-18（Round 1 実測）: 普通の笑顔での過検出を抑えるため 0.7→0.85 に引き上げ。
   */
  scoreThreshold: number;
  /**
   * 本人ベースライン比の**上昇量**（0〜1・faceRiseDelta・2026-07-18 追加）。
   * score - baseline がこの値以上であることが発火の必要条件（絶対閾値 scoreThreshold と AND）。
   * ベースライン = 顔スコアの直近 baselineWindowMs ローリング中央値。無表情→笑顔の「変化」を捉える。
   */
  riseDelta: number;
  /**
   * ベースライン（本人の平常スコア）を採るローリング中央値の窓（ms・faceBaselineWindowMs）。
   * 短い笑顔のピークは 10 秒窓の中では少数派のため中央値はほぼ動かず、確実に上昇差が取れる。
   */
  baselineWindowMs: number;
  /** 発火に必要なスコア持続時間（ms・faceSustainMs）。 */
  sustainMs: number;
}

/**
 * 支給初期値（docs/detection-params.md）。
 * ※ チューニングは検収対象外（実測で調整する前提）。
 */
export const DEFAULT_FACE_TRIGGER_PARAMS: FaceTriggerParams = {
  // facePipeline の推論間隔（200ms）より細かく読み取り、時刻ベースで持続を測る。
  sampleIntervalMs: 100,
  // 表情スコアの絶対閾値 0.85（faceTriggerScore）。2026-07-18: 0.7→0.85。
  scoreThreshold: 0.85,
  // 本人ベースライン比の上昇量 0.4（faceRiseDelta・2026-07-18 追加）。
  riseDelta: 0.4,
  // ベースラインの直近10秒ローリング中央値窓（faceBaselineWindowMs・2026-07-18 追加）。
  baselineWindowMs: 10000,
  // 0.85 かつ 上昇 0.4 を 500ms 持続で発火（faceSustainMs）。2026-07-18: 300→500。
  sustainMs: 500,
};

/** 顔発火時に外へ渡す情報（発火時の face_score）。 */
export interface FaceTriggerEvent {
  /** 発火時の表情スコア（0〜1）。 */
  score: number;
  /** 発火時の本人ベースライン（直近10秒中央値）。デバッグ・観測用。 */
  baseline: number | null;
}

/** 観測用の内部状態スナップショット（デバッグパネル用）。 */
export interface FaceTriggerState {
  /** 直近サンプルの表情スコア（0〜1）。未サンプルは null。 */
  lastScore: number | null;
  /** 発火の絶対閾値（0〜1）。デバッグパネル表示用。 */
  threshold: number;
  /**
   * 本人ベースライン（顔スコアの直近10秒ローリング中央値・2026-07-18 追加）。
   * 窓が空なら null。計測ログ face_baseline・デバッグパネル表示用。
   */
  baseline: number | null;
  /** 上昇（スコア ≥ 絶対閾値 かつ 上昇差 ≥ riseDelta）の持続累積（ms）。sustainMs で発火。 */
  sustainedMs: number;
  /**
   * リアーム済み（再発火可能）か。発火直後は false になり、スコアが閾値未満に一度戻ると
   * true に復帰する（鳴りっぱなし・連続再発火の防止）。
   */
  armed: boolean;
}

/**
 * 表情スコアの発火判定器（顔トリガー・Phase 2）。
 *
 * push(score, nowMs) を約 sampleIntervalMs 間隔で呼ぶ。face_score が絶対閾値
 * scoreThreshold 以上を sustainMs 続けたら FaceTriggerEvent を返す（満たさなければ null）。
 * クールダウンは持たない（上位 handleTrigger の共有クールダウン8秒に委ねる）。
 */
export class FaceTrigger {
  private readonly p: FaceTriggerParams;

  private lastScore: number | null = null;
  private lastTimeMs: number | null = null;
  private sustainedMs = 0;
  // リアーム済み（再発火可能）か。発火直後は false、スコアが閾値未満に戻ると true へ復帰する。
  private armed = true;
  // 本人ベースライン（顔スコアの直近 baselineWindowMs ローリング中央値・2026-07-18 追加）。
  private readonly baselineMedian: RollingMedian;

  constructor(params: Partial<FaceTriggerParams> = {}) {
    this.p = { ...DEFAULT_FACE_TRIGGER_PARAMS, ...params };
    this.baselineMedian = new RollingMedian(this.p.baselineWindowMs);
  }

  /**
   * 表情スコア1サンプルを投入する（2026-07-18「変化」化）。
   * 絶対閾値 scoreThreshold 以上 **かつ** 本人ベースライン比の上昇 riseDelta 以上を
   * sustainMs 持続したら FaceTriggerEvent、しなければ null。
   *
   * @param score このサンプルの表情スコア（0〜1）
   * @param nowMs 現在時刻（ms・単調増加。テストでは擬似時刻を渡す）
   */
  push(score: number, nowMs: number): FaceTriggerEvent | null {
    const dt =
      this.lastTimeMs === null
        ? this.p.sampleIntervalMs
        : Math.max(0, Math.min(nowMs - this.lastTimeMs, this.p.sampleIntervalMs * 4));
    this.lastTimeMs = nowMs;
    this.lastScore = score;

    // 本人ベースライン（直近10秒中央値）を更新する。全サンプルを窓へ入れる
    //（短い笑顔のピークは10秒窓では少数派＝中央値をほぼ動かさないため、上昇差が確実に取れる。
    // 逆に長く笑い続けると中央値が上がって上昇差が縮み、自然に再発火しにくくなる＝過検出抑制）。
    this.baselineMedian.push(score, nowMs);
    const baseline = this.baselineMedian.median();

    // 絶対閾値未満: 「笑顔が収まった」とみなして持続をリセットしリアームする。
    if (score < this.p.scoreThreshold) {
      this.sustainedMs = 0;
      this.armed = true;
      return null;
    }

    // 本人比の上昇が足りない（絶対閾値は超えるがベースラインからの変化が小さい）: 持続を積まない。
    // ベースライン未確立（窓が空）は上昇差を評価できないため発火保留（持続を積まない）。
    const rising = baseline !== null && score - baseline >= this.p.riseDelta;
    if (!rising) {
      this.sustainedMs = 0;
      return null;
    }

    // 絶対閾値以上 かつ 上昇十分だがリアーム未済（前回発火からスコアが閾値未満へ戻っていない）。
    if (!this.armed) {
      return null;
    }

    // 発火条件を満たす: 持続を積算し、sustainMs 到達で発火する。
    this.sustainedMs += dt;
    if (this.sustainedMs >= this.p.sustainMs) {
      this.sustainedMs = 0;
      this.armed = false; // リアーム解除: スコアが閾値未満に戻るまで再発火しない
      return { score, baseline };
    }
    return null;
  }

  /** 観測用の内部状態スナップショット。 */
  snapshot(): FaceTriggerState {
    return {
      lastScore: this.lastScore,
      threshold: this.p.scoreThreshold,
      baseline: this.baselineMedian.median(),
      sustainedMs: this.sustainedMs,
      armed: this.armed,
    };
  }
}
