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

    // 上昇を sustain(150ms=3サンプル) 未満（2サンプル=100ms）だけ与え、すぐ静音へ戻す。
    // ※ 2026-07-05 に sustainMs を 200→150 へ変更したため「未満」は 2 サンプル。
    let fired = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let i = 0; i < 2; i++) {
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

  it("sample() は発火判定と独立に直近の rms_db / rms_rise を返す【修正2】", () => {
    const trig = new RmsTrigger();
    let t = 0;

    // サンプル前は rmsDb=null・rmsRise=0。
    const before = trig.sample();
    expect(before.rmsDb).toBeNull();
    expect(before.rmsRise).toBe(0);

    // -40dB で baseline を確立。
    feed(trig, -40, 120, 0);
    t = 120 * DT;
    const atBase = trig.sample();
    expect(atBase.rmsDb).toBeCloseTo(-40, 0);
    // baseline とほぼ同値なので rise は約0。
    expect(Math.abs(atBase.rmsRise)).toBeLessThan(1);

    // 声を張った直後は rise が正になる（baseline は緩いEMAなので即追随しない）。
    trig.push(-28, t);
    const risen = trig.sample();
    expect(risen.rmsDb).toBeCloseTo(-28, 0);
    expect(risen.rmsRise).toBeGreaterThan(5);
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

  // --- 修正4: baseline ウォームアップ（コールドスタート緩和） -----------------
  it("ウォームアップ中は τ=1s で速く順応し、ウォームアップ後は τ=4s で緩く順応する", () => {
    // baseline を -20dB に確立（初回有声サンプル＝baseline 確定の挙動は不変）。
    // その後 -40dB を流し続け、baseline がどれだけ速く -40 側へ降りるかを比較する。
    // ウォームアップ（有声3秒＝60サンプル）中は τ=1s で速く、その後は τ=4s で緩い。

    // (A) ウォームアップ中の順応: 冒頭から 10 サンプル（=500ms<3s）だけ -40 を流す。
    const warm = new RmsTrigger();
    let tA = 0;
    warm.push(-20, tA); // 初回有声サンプル → baseline=-20 確定
    tA += DT;
    for (let i = 0; i < 10; i++) {
      warm.push(-40, tA);
      tA += DT;
    }
    const warmBaseline = warm.snapshot(tA).baselineDb!;

    // (B) ウォームアップ後の順応の比較用: まず有声3秒（60サンプル）を -20 で消化して
    //     warmup を使い切り（baseline は -20 のまま）、その後 10 サンプルだけ -40 を流す。
    const cold = new RmsTrigger();
    let tB = 0;
    cold.push(-20, tB); // baseline=-20 確定
    tB += DT;
    for (let i = 0; i < 60; i++) {
      // 有声 -20 を 3秒ぶん（warmup を消化。baseline は -20 付近を維持）。
      cold.push(-20, tB);
      tB += DT;
    }
    const beforeStep = cold.snapshot(tB).baselineDb!;
    expect(beforeStep).toBeCloseTo(-20, 0); // まだ -20 付近
    for (let i = 0; i < 10; i++) {
      cold.push(-40, tB);
      tB += DT;
    }
    const coldBaseline = cold.snapshot(tB).baselineDb!;

    // どちらも -20 から -40 へ向かって降下するが、
    // ウォームアップ中（τ=1s）のほうが同じ 10 サンプルでより深く降りる。
    const warmDrop = -20 - warmBaseline; // 正: 降下量
    const coldDrop = -20 - coldBaseline;
    // ウォームアップ中（τ=1s）は同じ 10 サンプルで通常運転（τ=4s）より明確に速く降りる。
    // 理論値: warm≈20*(1-(1-50/1000)^10)≈8.0dB / cold≈20*(1-(1-50/4000)^10)≈2.4dB。
    expect(warmDrop).toBeGreaterThan(coldDrop);
    expect(warmDrop).toBeGreaterThan(6); // ウォームアップは 500ms で 6dB 超降りる
    expect(warmDrop / coldDrop).toBeGreaterThan(2.5); // 通常運転より 2.5倍以上速い
  });

  it("通話冒頭にいきなり叫んでも、ウォームアップで基準が数秒で平常側へ降り追加発話で発火できる", () => {
    // 冒頭でいきなり大声（-20dB）→ baseline=-20 で確定してしまう（叫びっぱなしは発火しない）。
    // 従来（τ=4s のみ）だと baseline が -20 のまま高止まりし、普通の声（-40）では
    // rise が負のまま発火できない。ウォームアップ（τ=1s・有声3秒）で baseline が -40 付近まで
    // 数秒で降りてくるため、その後「声を張る（-32dB=+8dB 相当）」で発火できることを確認する。
    const trig = new RmsTrigger();
    let t = 0;
    trig.push(-20, t); // 冒頭の叫び → baseline=-20 確定
    t += DT;

    // 普通の会話音量 -40 を有声3秒ぶん（60サンプル）流す。ウォームアップで baseline が降りる。
    for (let i = 0; i < 60; i++) {
      trig.push(-40, t);
      t += DT;
    }
    const base = trig.snapshot(t).baselineDb!;
    // baseline が平常（-40付近）まで十分降りている（-30 より下）。
    expect(base).toBeLessThan(-30);

    // その後「声を張る」= baseline+riseThreshold 以上を sustain ぶん続けると発火する。
    const loud = base + DEFAULT_RMS_PARAMS.riseThresholdDb + 3;
    let fired = 0;
    for (let i = 0; i < 10; i++) {
      const ev = trig.push(loud, t);
      if (ev) fired += 1;
      t += DT;
    }
    expect(fired).toBe(1); // ウォームアップ後は追加発話で発火できる
  });
});
