// SlowGainNormalizer（マイク入力の自動ゲイン・純粋ロジック）の単体テスト（B）
//
// 検証観点（brief 指定）:
//   1. 小さい声（EMA が目標より低い）→ ゲインが少しずつ上がる（＋方向）
//   2. 目標より大きい声でもゲインは 0dB 未満へは下がらない（減衰しない・minGainDb=0）
//   3. ゲインは 1 更新あたり ±slew（2dB）を超えて動かない（急変しない）
//   4. ゲインは maxGainDb(+18dB) を超えない
//   5. 無音（voicedFloor 未満）は EMA に混ざらない
//   6. 更新間隔（2s）未満ではゲインは動かない

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLOW_GAIN_PARAMS,
  SlowGainNormalizer,
  dbToLinear,
} from "../src/modules/call/autoGain";

const P = DEFAULT_SLOW_GAIN_PARAMS;
const DT = 50; // 50ms 間隔

/** db を count 回 DT 間隔で投入し、最終ゲイン（dB）を返す。 */
function feed(n: SlowGainNormalizer, db: number, count: number, startMs = 0): number {
  let t = startMs;
  for (let i = 0; i < count; i++) {
    n.pushSample(db, t);
    t += DT;
  }
  return n.targetGainDb();
}

describe("SlowGainNormalizer", () => {
  it("小さい声だとゲインが上がる（＋方向）", () => {
    const n = new SlowGainNormalizer();
    // -50dBFS（目標 -30 より 20dB 低い）を十分な時間投入する。
    const gain = feed(n, -50, 400); // 400*50ms = 20s（更新10回ぶん）
    expect(gain).toBeGreaterThan(0);
    // 目標差（+20dB）へ向かうが上限 +18dB でクランプされる。
    expect(gain).toBeLessThanOrEqual(P.maxGainDb + 1e-6);
  });

  it("大きい声でもゲインは 0dB 未満へは下がらない（減衰しない）", () => {
    const n = new SlowGainNormalizer();
    // -10dBFS（目標 -30 より 20dB 高い＝desired -20dB）でも 0dB でクランプ。
    const gain = feed(n, -10, 400);
    expect(gain).toBeGreaterThanOrEqual(P.minGainDb - 1e-6);
    expect(gain).toBeCloseTo(0, 5);
  });

  it("1 更新あたり ±slew(2dB) を超えて動かない", () => {
    const n = new SlowGainNormalizer();
    // 有声で目標より低い声（-50dBFS＝voicedFloor -55 より上）＝desired +18dB へ寄せたい状況。
    // updateIntervalMs=2000ms / DT=50ms = 40 サンプルで最初の更新が起きる。
    const updateSamples = P.updateIntervalMs / DT; // 40
    // 41サンプルで更新1回（インデックス0で lastUpdateMs 確定→2s後の1サンプルで1更新）。
    const gain = feed(n, -50, updateSamples + 1);
    // 1 更新なので slew 上限 = 2dB を超えない。
    expect(gain).toBeLessThanOrEqual(P.slewDbPerUpdate + 1e-6);
    expect(gain).toBeGreaterThan(0);
  });

  it("ゲインは maxGainDb(+18dB) を超えない", () => {
    const n = new SlowGainNormalizer();
    // 有声で小さい声（-50dBFS）を長時間 → desired +20dB だが上限 +18dB でクランプ。
    const gain = feed(n, -50, 2000);
    expect(gain).toBeLessThanOrEqual(P.maxGainDb + 1e-6);
    expect(gain).toBeCloseTo(P.maxGainDb, 1);
  });

  it("無音（voicedFloor 未満）は EMA に混ざらない", () => {
    const n = new SlowGainNormalizer();
    // 無音（-100dBFS）だけを投入 → EMA は確定せず、ゲインは初期 0dB のまま。
    const gain = feed(n, -100, 400);
    expect(n.snapshot().emaDbfs).toBeNull();
    expect(gain).toBeCloseTo(0, 5);
  });

  it("更新間隔（2s）未満ではゲインは動かない", () => {
    const n = new SlowGainNormalizer();
    // updateIntervalMs=2000ms 未満（39サンプル=1.95s）ではゲインは 0dB のまま。
    const samples = P.updateIntervalMs / DT - 1; // 39
    const gain = feed(n, -50, samples);
    expect(gain).toBeCloseTo(0, 5);
  });

  it("dbToLinear は 0dB=1・+6dB≈2 を返す", () => {
    expect(dbToLinear(0)).toBeCloseTo(1, 6);
    expect(dbToLinear(6)).toBeCloseTo(1.995, 2);
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 2);
  });

  it("targetGainLinear は現在ゲインの倍率", () => {
    const n = new SlowGainNormalizer();
    feed(n, -50, 400);
    const gainDb = n.targetGainDb();
    expect(n.targetGainLinear()).toBeCloseTo(dbToLinear(gainDb), 6);
  });
});
