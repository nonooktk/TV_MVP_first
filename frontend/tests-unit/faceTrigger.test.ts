// 顔トリガー（家族側の表情スコア発火・Phase 2）の単体テスト。
//
// 検証観点（指示準拠）:
//   1. 閾値: face_score が絶対閾値 0.7 以上で発火する（未満では発火しない）。
//   2. 持続: 0.7 以上が sustainMs（300ms）持続して初めて発火する。
//   3. リアーム: 発火後はスコアが閾値未満に一度戻るまで再発火しない。
//   4. 共有クールダウン参加: FaceTrigger 自身はクールダウンを持たず（リアーム後は即再発火可能）、
//      全系統共有クールダウン（8秒）は上位 handleTrigger（passesSharedCooldown）で横断適用される。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FACE_TRIGGER_PARAMS,
  FaceTrigger,
} from "../src/modules/detection/faceTrigger";
import { passesSharedCooldown } from "../src/modules/detection/sttConfig";
import { DEFAULT_RMS_PARAMS } from "../src/modules/detection/rmsTrigger";

const DT = DEFAULT_FACE_TRIGGER_PARAMS.sampleIntervalMs; // 100ms
const TH = DEFAULT_FACE_TRIGGER_PARAMS.scoreThreshold; // 0.7
const SUSTAIN = DEFAULT_FACE_TRIGGER_PARAMS.sustainMs; // 300ms

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

describe("顔トリガー: 閾値と持続", () => {
  it("スコアが閾値(0.7)以上を300ms持続すると1回発火する", () => {
    const trig = new FaceTrigger();
    // t=0 で 100ms、t=100 で 200ms、t=200 で 300ms 到達 → 発火。
    let fired = false;
    let t = 0;
    for (let i = 0; i < 3; i++) {
      if (trig.push(0.8, t)) fired = true;
      t += DT;
    }
    expect(fired).toBe(true);
    // 発火直後は armed=false（リアーム未済）。
    expect(trig.snapshot().armed).toBe(false);
  });

  it("スコアが閾値未満(0.6)では持続しても発火しない", () => {
    const trig = new FaceTrigger();
    const { fires } = pushN(trig, TH - 0.1, 50, 0);
    expect(fires).toBe(0);
    expect(trig.snapshot().sustainedMs).toBe(0);
  });

  it("持続が足りない(200ms<300ms)と発火せず、閾値未満へ落ちると持続はリセットされる", () => {
    const trig = new FaceTrigger();
    // 0.8 を2サンプル（100+100=200ms）→ 未発火。
    expect(trig.push(0.8, 0)).toBeNull();
    expect(trig.push(0.8, 100)).toBeNull();
    expect(trig.snapshot().sustainedMs).toBe(200);
    // 閾値未満へ → 持続リセット＆リアーム。
    expect(trig.push(0.4, 200)).toBeNull();
    expect(trig.snapshot().sustainedMs).toBe(0);
    expect(trig.snapshot().armed).toBe(true);
  });

  it("ちょうど閾値(0.7)でも発火対象（>=判定）", () => {
    const trig = new FaceTrigger();
    let fired = false;
    let t = 0;
    for (let i = 0; i < 4; i++) {
      if (trig.push(TH, t)) fired = true;
      t += DT;
    }
    expect(fired).toBe(true);
  });
});

describe("顔トリガー: リアーム（発火後は閾値未満に戻るまで再発火しない）", () => {
  it("発火後に高スコアを維持しても再発火しない。閾値未満に戻ってから再度持続すると再発火する", () => {
    const trig = new FaceTrigger();
    // 1回目の発火。
    const first = pushN(trig, 0.9, 4, 0);
    expect(first.fires).toBe(1);

    // 高スコアを維持（armed=false のまま）→ 再発火しない。
    const held = pushN(trig, 0.9, 20, first.endMs);
    expect(held.fires).toBe(0);
    expect(trig.snapshot().armed).toBe(false);

    // 閾値未満へ一度戻す（リアーム）。
    trig.push(0.3, held.endMs);
    expect(trig.snapshot().armed).toBe(true);

    // 再び高スコアを持続 → 再発火する。
    const second = pushN(trig, 0.9, 4, held.endMs + DT);
    expect(second.fires).toBe(1);
  });
});

describe("顔トリガー: 共有クールダウン参加（内部クールダウンは持たない）", () => {
  it("FaceTrigger 自身はクールダウンを持たず、リアーム後は8秒未満でも即再発火できる", () => {
    const trig = new FaceTrigger();
    // 1回目発火。
    expect(pushN(trig, 0.9, 4, 0).fires).toBe(1);
    // わずかに閾値未満へ落としてリアーム（数百ms 後）。
    trig.push(0.2, 500);
    // 8秒よりずっと早く（+約1秒）再度持続 → FaceTrigger 単体では再発火できる
    //（＝連打抑止は FaceTrigger ではなく上位の共有クールダウンが担う）。
    expect(pushN(trig, 0.9, 4, 1000).fires).toBe(1);
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

describe("顔トリガー: パラメータ（支給初期値）", () => {
  it("faceTriggerScore=0.7 / faceSustainMs=300 が支給初期値", () => {
    expect(TH).toBe(0.7);
    expect(SUSTAIN).toBe(300);
  });
});
