// スペクトル重心トリガー（改良2・純粋ロジック）の単体テスト。
//
// 検証観点（承認済み仕様・docs/detection-params.md 準拠）:
//   1. 基準（発話重心の中央値）が確立してから、基準比 +20% を 200ms 持続で発火する
//   2. 持続不足では発火しない
//   3. 盛り上がり（基準比 ≥ 1.2）のフレームは中央値窓に入れない（基準を吊り上げない）
//   4. spectralCentroidHz: 高域にエネルギーが偏るほど重心が高くなる

import { describe, expect, it } from "vitest";
import {
  CentroidTrigger,
  DEFAULT_CENTROID_PARAMS,
  spectralCentroidHz,
} from "../src/modules/detection/centroidTrigger";

const DT = DEFAULT_CENTROID_PARAMS.sampleIntervalMs; // 50ms

describe("CentroidTrigger", () => {
  it("基準確立後、基準比 +20% を 200ms 持続すると発火する", () => {
    const trig = new CentroidTrigger();
    let t = 0;

    // 平常の重心 1000Hz を 2 秒（40サンプル）流して基準（中央値）を 1000 に確立。
    for (let i = 0; i < 40; i++) {
      const ev = trig.push(1000, t);
      expect(ev).toBeNull(); // 基準比 1.0 では発火しない
      t += DT;
    }
    expect(trig.snapshot().baselineHz).toBeCloseTo(1000, 0);

    // 声色が高くなる: 1250Hz（基準比 +25% ≥ +20%）を 200ms（4サンプル）以上持続。
    let fired = 0;
    let firedEv = null;
    for (let i = 0; i < 6; i++) {
      const ev = trig.push(1250, t);
      if (ev) {
        fired += 1;
        firedEv = ev;
      }
      t += DT;
    }
    expect(fired).toBe(1);
    expect(firedEv!.centroidHz).toBe(1250);
    expect(firedEv!.riseRatio).toBeGreaterThanOrEqual(1.2);
    expect(firedEv!.baselineHz).toBeCloseTo(1000, 0);
  });

  it("持続不足（200ms 未満）では発火しない", () => {
    const trig = new CentroidTrigger();
    let t = 0;
    for (let i = 0; i < 40; i++) {
      trig.push(1000, t);
      t += DT;
    }
    // +25% を 3 サンプル（150ms < 200ms）だけ与えては平常へ戻す、を繰り返す。
    let fired = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let i = 0; i < 3; i++) {
        if (trig.push(1250, t)) fired += 1;
        t += DT;
      }
      for (let i = 0; i < 5; i++) {
        if (trig.push(1000, t)) fired += 1;
        t += DT;
      }
    }
    expect(fired).toBe(0);
  });

  it("盛り上がり（+20% 超）のフレームは中央値窓に入らず基準を吊り上げない", () => {
    const trig = new CentroidTrigger();
    let t = 0;
    // 平常 1000Hz を 2 秒。基準 1000。
    for (let i = 0; i < 40; i++) {
      trig.push(1000, t);
      t += DT;
    }
    const base0 = trig.snapshot().baselineHz!;
    // 高い声 1400Hz（+40%）を長く流しても、盛り上がりは窓に入らないため基準は 1000 付近据え置き。
    for (let i = 0; i < 100; i++) {
      trig.push(1400, t);
      t += DT;
    }
    const base1 = trig.snapshot().baselineHz!;
    expect(Math.abs(base1 - base0)).toBeLessThan(50); // ほぼ据え置き
  });

  it("sample() は直近の重心と基準比を返す（読み取り専用）", () => {
    const trig = new CentroidTrigger();
    let t = 0;
    for (let i = 0; i < 40; i++) {
      trig.push(1000, t);
      t += DT;
    }
    trig.push(1300, t);
    const s = trig.sample();
    expect(s.centroidHz).toBe(1300);
    expect(s.riseRatio).toBeCloseTo(1.3, 1);
  });
});

describe("spectralCentroidHz", () => {
  it("高域にエネルギーが偏るほど重心が高くなる", () => {
    const sampleRate = 48000;
    const n = 512; // frequencyBinCount（fftSize=1024）
    // 低域寄り（ビン 10 付近にエネルギー）。
    const low = new Float32Array(n).fill(-140);
    low[10] = -10;
    // 高域寄り（ビン 200 付近にエネルギー）。
    const high = new Float32Array(n).fill(-140);
    high[200] = -10;

    const lowHz = spectralCentroidHz(low, sampleRate);
    const highHz = spectralCentroidHz(high, sampleRate);
    expect(highHz).toBeGreaterThan(lowHz);
    // ビン i の周波数 = i * sampleRate / fftSize = i * 48000 / 1024。
    expect(lowHz).toBeCloseTo((10 * sampleRate) / (n * 2), 0);
    expect(highHz).toBeCloseTo((200 * sampleRate) / (n * 2), 0);
  });

  it("エネルギーが無い（全て下限）なら 0 を返す", () => {
    const silent = new Float32Array(512).fill(-Infinity);
    expect(spectralCentroidHz(silent, 48000)).toBe(0);
  });
});
