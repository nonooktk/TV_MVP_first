// 顔トリガー（家族側の表情スコア発火・Phase 2 → 2026-07-18 Round 1「変化」化）の単体テスト。
//
// 【2026-07-18 Round 1 実測に基づく再構成に追随して更新】
//   絶対値 0.7×300ms → 「絶対 0.85 かつ 本人ベースライン比の上昇 0.4」を 500ms 持続。
//   ベースライン = 顔スコアの直近10秒ローリング中央値。普通の笑顔（ずっと高いだけ）では
//   発火せず、無表情→笑顔の「変化」で発火する。
//
// 検証観点（指示準拠）:
//   1. 絶対 0.85 かつ 本人比 +0.4 上昇 を 500ms 持続で1回発火する。
//   2. 絶対閾値未満（<0.85）では発火しない。
//   3. 絶対閾値は超えるが本人比の上昇が足りない（ずっと笑顔＝変化なし）と発火しない。
//   4. 持続不足（<500ms）では発火せず、閾値未満へ落ちると持続リセット＆リアーム。
//   5. リアーム: 発火後はスコアが 0.85 未満に一度戻るまで再発火しない。
//   6. 共有クールダウン参加: FaceTrigger 自身はクールダウンを持たない（連打抑止は上位）。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FACE_TRIGGER_PARAMS,
  FaceTrigger,
} from "../src/modules/detection/faceTrigger";
import { passesSharedCooldown } from "../src/modules/detection/sttConfig";
import { DEFAULT_RMS_PARAMS } from "../src/modules/detection/rmsTrigger";

const DT = DEFAULT_FACE_TRIGGER_PARAMS.sampleIntervalMs; // 100ms
const TH = DEFAULT_FACE_TRIGGER_PARAMS.scoreThreshold; // 0.85
const SUSTAIN = DEFAULT_FACE_TRIGGER_PARAMS.sustainMs; // 500ms
const RISE = DEFAULT_FACE_TRIGGER_PARAMS.riseDelta; // 0.4

/** neutral な score を n サンプル流して本人ベースライン（中央値）を確立する。終端時刻を返す。 */
function establishBaseline(
  trig: FaceTrigger,
  level: number,
  n: number,
  startMs: number
): number {
  let t = startMs;
  for (let i = 0; i < n; i++) {
    trig.push(level, t);
    t += DT;
  }
  return t;
}

/** score を n サンプル連続で push し、発火回数を返す（時刻は DT 間隔で進める）。 */
function pushN(
  trig: FaceTrigger,
  score: number,
  n: number,
  startMs: number
): { fires: number; endMs: number } {
  let t = startMs;
  let fires = 0;
  for (let i = 0; i < n; i++) {
    if (trig.push(score, t)) fires += 1;
    t += DT;
  }
  return { fires, endMs: t };
}

describe("顔トリガー: 変化（絶対0.85 かつ 本人比+0.4上昇）と持続", () => {
  it("無表情→笑顔の変化: 絶対0.85かつ本人比+0.4上昇を500ms持続すると1回発火する", () => {
    const trig = new FaceTrigger();
    // 無表情（0.1）を5秒流して本人ベースライン≈0.1 を確立する。
    let t = establishBaseline(trig, 0.1, 50, 0);
    // 0.95（絶対 ≥0.85・上昇 0.85 ≥0.4）を 500ms（5サンプル）持続 → 発火。
    let fired = false;
    let firedAt = -1;
    for (let i = 0; i < 6; i++) {
      if (trig.push(0.95, t)) {
        fired = true;
        if (firedAt < 0) firedAt = i;
      }
      t += DT;
    }
    expect(fired).toBe(true);
    expect(firedAt).toBe(4); // 100ms×5=500ms 到達の5サンプル目（index 4）で発火
    // 発火直後は armed=false（リアーム未済）。
    expect(trig.snapshot().armed).toBe(false);
  });

  it("絶対閾値未満(0.8<0.85)では、本人比の上昇があっても発火しない", () => {
    const trig = new FaceTrigger();
    const t = establishBaseline(trig, 0.1, 50, 0);
    const { fires } = pushN(trig, 0.8, 30, t); // 0.8 は絶対閾値 0.85 未満
    expect(fires).toBe(0);
    expect(trig.snapshot().sustainedMs).toBe(0);
  });

  it("ずっと笑顔（本人比の上昇なし）では発火しない: 絶対閾値は超えても“変化”が無い", () => {
    const trig = new FaceTrigger();
    // ずっと 0.9 で笑っている人＝本人ベースライン自体が 0.9 になる。
    let t = establishBaseline(trig, 0.9, 60, 0);
    // さらに 0.95 にしても、本人比の上昇は 0.05（<0.4）しかない → 発火しない。
    const { fires } = pushN(trig, 0.95, 30, t);
    expect(fires).toBe(0);
  });

  it("持続が足りない(400ms<500ms)と発火せず、閾値未満へ落ちると持続はリセット＆リアーム", () => {
    const trig = new FaceTrigger();
    let t = establishBaseline(trig, 0.1, 50, 0);
    // 0.95 を4サンプル（400ms）→ 未発火。
    for (let i = 0; i < 4; i++) {
      expect(trig.push(0.95, t)).toBeNull();
      t += DT;
    }
    expect(trig.snapshot().sustainedMs).toBe(400);
    // 閾値未満へ → 持続リセット＆リアーム。
    expect(trig.push(0.4, t)).toBeNull();
    expect(trig.snapshot().sustainedMs).toBe(0);
    expect(trig.snapshot().armed).toBe(true);
  });

  it("ちょうど絶対閾値0.85でも発火対象（>=判定・本人比の上昇は十分）", () => {
    const trig = new FaceTrigger();
    // ベースライン 0.2 → 0.85 は上昇 0.65（≥0.4）。絶対も 0.85（>=）。
    let t = establishBaseline(trig, 0.2, 50, 0);
    let fired = false;
    for (let i = 0; i < 6; i++) {
      if (trig.push(TH, t)) fired = true;
      t += DT;
    }
    expect(fired).toBe(true);
  });

  it("発火時イベントに発火スコアと本人ベースラインが載る", () => {
    const trig = new FaceTrigger();
    let t = establishBaseline(trig, 0.1, 50, 0);
    let ev = null;
    for (let i = 0; i < 6 && !ev; i++) {
      ev = trig.push(0.95, t);
      t += DT;
    }
    expect(ev).not.toBeNull();
    expect(ev!.score).toBe(0.95);
    expect(ev!.baseline).toBeCloseTo(0.1, 1);
  });
});

describe("顔トリガー: リアーム（発火後は絶対閾値未満に戻るまで再発火しない）", () => {
  it("発火後に高スコアを維持しても再発火しない。閾値未満に戻ってから再度持続すると再発火する", () => {
    const trig = new FaceTrigger();
    let t = establishBaseline(trig, 0.1, 50, 0);

    // 1回目の発火。
    const first = pushN(trig, 0.95, 6, t);
    expect(first.fires).toBe(1);

    // 高スコアを維持（armed=false のまま）→ 再発火しない。
    const held = pushN(trig, 0.95, 20, first.endMs);
    expect(held.fires).toBe(0);
    expect(trig.snapshot().armed).toBe(false);

    // 絶対閾値未満へ一度戻す（リアーム）。
    trig.push(0.2, held.endMs);
    expect(trig.snapshot().armed).toBe(true);

    // 再び高スコアを持続 → 再発火する。
    const second = pushN(trig, 0.95, 6, held.endMs + DT);
    expect(second.fires).toBe(1);
  });
});

describe("顔トリガー: 共有クールダウン参加（内部クールダウンは持たない）", () => {
  it("FaceTrigger 自身はクールダウンを持たず、リアーム後は8秒未満でも即再発火できる", () => {
    const trig = new FaceTrigger();
    let t = establishBaseline(trig, 0.1, 50, 0);
    // 1回目発火。
    const first = pushN(trig, 0.95, 6, t);
    expect(first.fires).toBe(1);
    // わずかに閾値未満へ落としてリアーム。
    trig.push(0.2, first.endMs);
    // 8秒よりずっと早く再度持続 → FaceTrigger 単体では再発火できる
    //（＝連打抑止は FaceTrigger ではなく上位の共有クールダウンが担う）。
    const second = pushN(trig, 0.95, 6, first.endMs + DT);
    expect(second.fires).toBe(1);
  });

  it("上位の共有クールダウン（8秒）は reason='face' の発火も横断的に抑止する", () => {
    // handleTrigger 内の lastTriggerAtMs 相当。face 発火も isRealTrigger に含まれ、
    // passesSharedCooldown で他系統（rms/centroid/stt）と共有の8秒に参加する。
    const SHARED = DEFAULT_RMS_PARAMS.cooldownMs; // 8000ms
    const T0 = 1_700_000_000_000;
    let lastTriggerAtMs = 0;
    // face が発火。
    expect(passesSharedCooldown(T0, lastTriggerAtMs, SHARED)).toBe(true);
    lastTriggerAtMs = T0;
    // 8秒未満: 次の face（や rms/centroid）は抑止される。
    expect(passesSharedCooldown(T0 + 5000, lastTriggerAtMs, SHARED)).toBe(false);
    // 8秒経過: 通過。
    expect(passesSharedCooldown(T0 + 8000, lastTriggerAtMs, SHARED)).toBe(true);
  });
});

describe("顔トリガー: パラメータ（支給初期値・2026-07-18 Round 1）", () => {
  it("faceTriggerScore=0.85 / faceRiseDelta=0.4 / faceSustainMs=500 / faceBaselineWindowMs=10000", () => {
    expect(TH).toBe(0.85);
    expect(RISE).toBe(0.4);
    expect(SUSTAIN).toBe(500);
    expect(DEFAULT_FACE_TRIGGER_PARAMS.baselineWindowMs).toBe(10000);
  });
});
