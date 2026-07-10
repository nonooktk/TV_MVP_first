// 委託コア②（検知キャプチャ）: 顔トリガー（家族側の表情スコア発火・純粋ロジック・Phase 2）
//
// 顔検知の家族側化（Phase 2）に伴い新設。家族側ローカルカメラ（孫が映る側）の表情スコア
// （face_score・既存の facePipeline が算出する mouthSmile 系 blendshape 平均 0〜1）を
// 音圧（RMS）・声色（重心）とは独立の軸で発火させる。
//
// 設計（承認済み仕様・docs/detection-params.md）:
//   - 入力は facePipeline.score()（0〜1）を約 sampleIntervalMs 間隔で push する。
//   - 発火条件: face_score が **絶対閾値 scoreThreshold（0.7）を sustainMs（300ms）持続**。
//     baseline 比ではなく絶対閾値である点が RMS/重心と異なる（笑顔の絶対的な強さで発火）。
//   - リアーム: 発火後は「スコアが閾値未満に一度戻る」まで再発火しない（armed=false→true）。
//   - クールダウンは持たない（上位 handleTrigger の全系統共有クールダウン8秒に委ねる。
//     RMS/STT/重心/顔・elder/family のどれが発火しても横断的に次の8秒を抑止する）。
//
// DOM / WebAudio 非依存の純粋ロジック（vitest で単体テストする）。
//
// 【重要】ここに置く数値は「支給初期値」であり、精度チューニングは検収対象外
// （docs/detection-params.md・CLAUDE.md の開発ルール）。

/** 顔トリガーのパラメータ（支給初期値。チューニングは検収対象外）。 */
export interface FaceTriggerParams {
  /** サンプル間隔の想定値（ms）。持続の時間換算に使う。 */
  sampleIntervalMs: number;
  /**
   * 発火とみなす表情スコアの**絶対閾値**（0〜1）。face_score がこの値以上で持続すると発火する。
   * RMS/重心の「baseline 比」とは異なり絶対値で判定する（笑顔の強さそのもので発火）。
   */
  scoreThreshold: number;
  /** 発火に必要なスコア持続時間（ms）。 */
  sustainMs: number;
}

/**
 * 支給初期値（docs/detection-params.md）。
 * ※ チューニングは検収対象外（実測で調整する前提）。
 */
export const DEFAULT_FACE_TRIGGER_PARAMS: FaceTriggerParams = {
  // facePipeline の推論間隔（200ms）より細かく読み取り、時刻ベースで持続を測る。
  sampleIntervalMs: 100,
  // 表情スコアの絶対閾値 +0.7（faceTriggerScore）。
  scoreThreshold: 0.7,
  // 0.7 を 300ms 持続で発火（faceSustainMs）。
  sustainMs: 300,
};

/** 顔発火時に外へ渡す情報（発火時の face_score）。 */
export interface FaceTriggerEvent {
  /** 発火時の表情スコア（0〜1）。 */
  score: number;
}

/** 観測用の内部状態スナップショット（デバッグパネル用）。 */
export interface FaceTriggerState {
  /** 直近サンプルの表情スコア（0〜1）。未サンプルは null。 */
  lastScore: number | null;
  /** 発火の絶対閾値（0〜1）。デバッグパネル表示用。 */
  threshold: number;
  /** 上昇（スコア ≥ 閾値）の持続累積（ms）。sustainMs に達すると発火する。 */
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

  constructor(params: Partial<FaceTriggerParams> = {}) {
    this.p = { ...DEFAULT_FACE_TRIGGER_PARAMS, ...params };
  }

  /**
   * 表情スコア1サンプルを投入する。
   * 絶対閾値 scoreThreshold 以上を sustainMs 持続したら FaceTriggerEvent、しなければ null。
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

    // 閾値未満: 「笑顔が収まった」とみなして持続をリセットしリアームする。
    if (score < this.p.scoreThreshold) {
      this.sustainedMs = 0;
      this.armed = true;
      return null;
    }

    // 閾値以上だがリアーム未済（前回発火からスコアが閾値未満へ戻っていない）は発火しない。
    if (!this.armed) {
      return null;
    }

    // 閾値以上かつリアーム済み: 持続を積算し、sustainMs 到達で発火する。
    this.sustainedMs += dt;
    if (this.sustainedMs >= this.p.sustainMs) {
      this.sustainedMs = 0;
      this.armed = false; // リアーム解除: スコアが閾値未満に戻るまで再発火しない
      return { score };
    }
    return null;
  }

  /** 観測用の内部状態スナップショット。 */
  snapshot(): FaceTriggerState {
    return {
      lastScore: this.lastScore,
      threshold: this.p.scoreThreshold,
      sustainedMs: this.sustainedMs,
      armed: this.armed,
    };
  }
}
