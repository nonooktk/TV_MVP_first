// RmsTrigger（RMS音圧の発火判定・純粋ロジック）の単体テスト（M2）
//
// 検証観点（指示・docs/detection-params.md 準拠）:
//   1. 上昇が持続すると発火する
//   2. 持続不足では発火しない
//   3. クールダウン中は発火しない
//   4. 無音（VADゲート未満）では baseline が動かない・発火しない

import { describe, expect, it } from "vitest";
import { DEFAULT_RMS_PARAMS, RmsTrigger } from "../src/modules/detection/rmsTrigger";

const DT = DEFAULT_RMS_PARAMS.sampleIntervalMs; // 50ms

/**
 * 一定 dB のサンプルを count 回、DT間隔で投入する。
 * 発火した RmsTriggerEvent を配列で返す。
 */
function feed(
  trig: RmsTrigger,
  db: number,
  count: number,
  startMs: number
): { fired: number; lastMs: number } {
  let fired = 0;
  let t = startMs;
  for (let i = 0; i < count; i++) {
    const ev = trig.push(db, t);
    if (ev) fired += 1;
    t += DT;
  }
  return { fired, lastMs: t };
}

describe("RmsTrigger", () => {
  it("baseline を確立したうえで、しきい値超えの上昇が sustain 時間続くと発火する", () => {
    const trig = new RmsTrigger();
    let t = 0;

    // まず静かな有声（-40dB）を baseline 確立ぶん流す（τ=4s に十分な長さ）。
    const quiet = feed(trig, -40, 120, t); // 120 * 50ms = 6s
    t = quiet.lastMs;
    expect(quiet.fired).toBe(0);

    const base = trig.snapshot(t).baselineDb!;
    expect(base).toBeCloseTo(-40, 0);

    // 声を張る: baseline+8dB 以上（-30dB=+10dB）を sustain(200ms=4サンプル) 以上続ける。
    let firedTotal = 0;
    for (let i = 0; i < 10; i++) {
      const ev = trig.push(-30, t);
      if (ev) firedTotal += 1;
      t += DT;
    }
    expect(firedTotal).toBe(1); // クールダウンにより1回だけ発火する

    // 発火イベントの中身を確認するため、別インスタンスで単発検証。
    const trig2 = new RmsTrigger();
    let t2 = 0;
    feed(trig2, -40, 120, 0);
    t2 = 120 * DT;
    let ev = null;
    for (let i = 0; i < 6 && !ev; i++) {
      ev = trig2.push(-30, t2);
      t2 += DT;
    }
    expect(ev).not.toBeNull();
    expect(ev!.reason).toBe("rms");
    expect(ev!.rmsRise).toBeGreaterThanOrEqual(DEFAULT_RMS_PARAMS.riseThresholdDb);
    expect(ev!.rmsDb).toBeCloseTo(-30, 0);
  });

  it("持続不足（sustain 未満）では発火しない", () => {
    const trig = new RmsTrigger();
    let t = 0;
    feed(trig, -40, 120, 0);
    t = 120 * DT;

    // 上昇を sustain(200ms=4サンプル) 未満（3サンプル=150ms）だけ与え、すぐ静音へ戻す。
    let fired = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let i = 0; i < 3; i++) {
        const ev = trig.push(-30, t);
        if (ev) fired += 1;
        t += DT;
      }
      // 静音（baseより低め・ただしVAD以上）で持続をリセット
      for (let i = 0; i < 6; i++) {
        const ev = trig.push(-42, t);
        if (ev) fired += 1;
        t += DT;
      }
    }
    expect(fired).toBe(0);
  });

  it("クールダウン中は連続した上昇でも再発火しない", () => {
    const trig = new RmsTrigger();
    let t = 0;
    feed(trig, -40, 120, 0);
    t = 120 * DT;

    // 大声を長く継続（cooldown=4s=80サンプルより短い60サンプル=3s）。
    let fired = 0;
    for (let i = 0; i < 60; i++) {
      const ev = trig.push(-25, t);
      if (ev) fired += 1;
      t += DT;
    }
    // 最初の1回のみ発火し、クールダウン(4s)中は再発火しない。
    expect(fired).toBe(1);
  });

  it("クールダウン明け後は再び発火できる（大声→静音→大声）", () => {
    const trig = new RmsTrigger();
    let t = 0;
    feed(trig, -40, 120, 0);
    t = 120 * DT;

    let fired = 0;
    // 1回目の大声（sustain 到達で1発）→ 短く静音でクールダウンを消化
    // （静音では baseline を更新しないため baseline は -40 のまま保たれる）→ 2回目の大声。
    const burst = () => {
      for (let i = 0; i < 8; i++) {
        const ev = trig.push(-28, t);
        if (ev) fired += 1;
        t += DT;
      }
    };
    const silence = (n: number) => {
      for (let i = 0; i < n; i++) {
        trig.push(-70, t); // VAD未満: baseline 据え置き・持続リセット
        t += DT;
      }
    };

    burst(); // 1回目の発火（→ cooldown 4s 開始）
    silence(100); // 5s 静音（cooldown 4s を跨ぐ・baseline は不変）
    burst(); // 2回目の発火

    expect(fired).toBe(2);
  });

  it("無音（VADゲート未満）では baseline が更新されず、発火もしない", () => {
    const trig = new RmsTrigger();
    let t = 0;
    // まず有声で baseline を -40dB に確立。
    feed(trig, -40, 120, 0);
    t = 120 * DT;
    const baseBefore = trig.snapshot(t).baselineDb!;
    expect(baseBefore).toBeCloseTo(-40, 0);

    // VADゲート未満（-70dB < vadFloorDb=-55dB）を大量に流す。
    let fired = 0;
    for (let i = 0; i < 200; i++) {
      const ev = trig.push(-70, t);
      if (ev) fired += 1;
      t += DT;
    }
    expect(fired).toBe(0);

    // baseline は無音中に一切変化していない。
    const baseAfter = trig.snapshot(t).baselineDb!;
    expect(baseAfter).toBe(baseBefore);
  });

  it("無音を挟んでも直後の大声で誤発火しない（持続がリセットされる）", () => {
    const trig = new RmsTrigger();
    let t = 0;
    feed(trig, -40, 120, 0);
    t = 120 * DT;

    // 無音 → 1サンプルだけ大声 → 無音、を繰り返す（持続が積み上がらない）。
    let fired = 0;
    for (let cycle = 0; cycle < 20; cycle++) {
      trig.push(-70, t);
      t += DT; // 無音
      const ev = trig.push(-20, t);
      if (ev) fired += 1;
      t += DT; // 単発の大声
    }
    expect(fired).toBe(0);
  });
});
