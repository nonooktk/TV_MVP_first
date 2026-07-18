// スペクトル重心トリガー（改良2・純粋ロジック）の単体テスト。
//
// 【2026-07-07 実測フィードバックによる調整に追随して更新】
//   - 比率 +20%→+30%（CENTROID_RISE_RATIO=1.3）
//   - 発話ゲート成立（isSpeech）を発火条件に同時必須化。push シグネチャに isSpeech を追加。
//     持続カウントも発話フレームのみで積算し、非発話フレームでリセットする。
//   - リアーム条件の追加: 発火後は基準比が閾値未満に一度戻るまで再発火しない
//
// 検証観点（承認済み仕様・docs/detection-params.md 準拠）:
//   1. 基準（発話重心の中央値）が確立してから、基準比 +30% を 200ms 持続 かつ 発話ゲート成立で発火する
//   2. 持続不足では発火しない
//   3. 盛り上がり（基準比 ≥ 1.3）のフレームは中央値窓に入れない（基準を吊り上げない）
//   4. spectralCentroidHz: 高域にエネルギーが偏るほど重心が高くなる
//   5. 無言非発火: 発話ゲート不成立時は持続が積まれず発火しない（音圧が変わらなくても重心だけ
//      上がった無言区間で誤発火しないことを確認）
//   6. リアーム: 発火→高止まり中は再発火しない→比率が閾値未満に戻って再度上がると発火する

import { describe, expect, it } from "vitest";
import {
  CentroidTrigger,
  DEFAULT_CENTROID_PARAMS,
  spectralCentroidHz,
} from "../src/modules/detection/centroidTrigger";

const DT = DEFAULT_CENTROID_PARAMS.sampleIntervalMs; // 50ms

describe("CentroidTrigger", () => {
  it("基準確立後、基準比 +30% を 200ms 持続（発話ゲート成立）すると発火する", () => {
    const trig = new CentroidTrigger({ enabled: true });
    let t = 0;

    // 平常の重心 1000Hz を 2 秒（40サンプル）流して基準（中央値）を 1000 に確立（発話フレーム）。
    for (let i = 0; i < 40; i++) {
      const ev = trig.push(1000, true, t);
      expect(ev).toBeNull(); // 基準比 1.0 では発火しない
      t += DT;
    }
    expect(trig.snapshot().baselineHz).toBeCloseTo(1000, 0);

    // 声色が高くなる: 1350Hz（基準比 +35% ≥ +30%）を 200ms（4サンプル）以上持続かつ発話中。
    let fired = 0;
    let firedEv = null;
    for (let i = 0; i < 6; i++) {
      const ev = trig.push(1350, true, t);
      if (ev) {
        fired += 1;
        firedEv = ev;
      }
      t += DT;
    }
    expect(fired).toBe(1);
    expect(firedEv!.centroidHz).toBe(1350);
    expect(firedEv!.riseRatio).toBeGreaterThanOrEqual(1.3);
    expect(firedEv!.baselineHz).toBeCloseTo(1000, 0);
  });

  it("持続不足（200ms 未満）では発火しない", () => {
    const trig = new CentroidTrigger({ enabled: true });
    let t = 0;
    for (let i = 0; i < 40; i++) {
      trig.push(1000, true, t);
      t += DT;
    }
    // +35% を 3 サンプル（150ms < 200ms）だけ与えては平常へ戻す、を繰り返す。
    let fired = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let i = 0; i < 3; i++) {
        if (trig.push(1350, true, t)) fired += 1;
        t += DT;
      }
      for (let i = 0; i < 5; i++) {
        if (trig.push(1000, true, t)) fired += 1;
        t += DT;
      }
    }
    expect(fired).toBe(0);
  });

  it("盛り上がり（+30% 超）のフレームは中央値窓に入らず基準を吊り上げない", () => {
    const trig = new CentroidTrigger({ enabled: true });
    let t = 0;
    // 平常 1000Hz を 2 秒。基準 1000。
    for (let i = 0; i < 40; i++) {
      trig.push(1000, true, t);
      t += DT;
    }
    const base0 = trig.snapshot().baselineHz!;
    // 高い声 1500Hz（+50%）を長く流しても、盛り上がりは窓に入らないため基準は 1000 付近据え置き。
    for (let i = 0; i < 100; i++) {
      trig.push(1500, true, t);
      t += DT;
    }
    const base1 = trig.snapshot().baselineHz!;
    expect(Math.abs(base1 - base0)).toBeLessThan(50); // ほぼ据え置き
  });

  it("sample() は直近の重心と基準比を返す（読み取り専用）", () => {
    const trig = new CentroidTrigger({ enabled: true });
    let t = 0;
    for (let i = 0; i < 40; i++) {
      trig.push(1000, true, t);
      t += DT;
    }
    trig.push(1300, true, t);
    const s = trig.sample();
    expect(s.centroidHz).toBe(1300);
    expect(s.riseRatio).toBeCloseTo(1.3, 1);
  });

  // --- 発話ゲート必須化（2026-07-07）-------------------------------------------

  it("無言非発火: 発話ゲート不成立のフレームでは持続が積まれず発火しない", () => {
    const trig = new CentroidTrigger({ enabled: true });
    let t = 0;
    // 発話フレームで基準 1000Hz を確立。
    for (let i = 0; i < 40; i++) {
      trig.push(1000, true, t);
      t += DT;
    }
    // 重心だけが +35%（1350Hz）に上がっているが、非発話（isSpeech=false）のフレームとして
    // 200ms 超（6サンプル）投入する → 発話ゲート不成立のため発火しない。
    let fired = 0;
    for (let i = 0; i < 6; i++) {
      const ev = trig.push(1350, false, t);
      if (ev) fired += 1;
      t += DT;
    }
    expect(fired).toBe(0);
    // 持続カウントも積まれていない（非発話でリセットされ続ける）。
    expect(trig.snapshot().sustainedMs).toBe(0);
  });

  it("無言非発火: 発話↔非発話が交互だと持続がリセットされ続けて発火しない", () => {
    const trig = new CentroidTrigger({ enabled: true });
    let t = 0;
    for (let i = 0; i < 40; i++) {
      trig.push(1000, true, t);
      t += DT;
    }
    // 発話フレームで基準比 +35%（1350Hz）→ 非発話フレームで同じ値、を交互に与える。
    // 発話フレームの連続が sustainMs(200ms=4サンプル) に届く前に非発話でリセットされる。
    let fired = 0;
    for (let cycle = 0; cycle < 10; cycle++) {
      for (let i = 0; i < 2; i++) {
        // 200ms未満
        if (trig.push(1350, true, t)) fired += 1;
        t += DT;
      }
      if (trig.push(1350, false, t)) fired += 1; // 非発話でリセット
      t += DT;
    }
    expect(fired).toBe(0);
  });

  // --- リアーム条件（2026-07-07 追加）-----------------------------------------

  it("リアーム: 発火→高止まり中は再発火しない→比率が閾値未満に戻って再度上がると発火する", () => {
    const trig = new CentroidTrigger({ enabled: true });
    let t = 0;
    for (let i = 0; i < 40; i++) {
      trig.push(1000, true, t);
      t += DT;
    }

    // 1回目発火（1350Hz・+35%）。
    let fired1 = 0;
    for (let i = 0; i < 6; i++) {
      const ev = trig.push(1350, true, t);
      if (ev) fired1 += 1;
      t += DT;
    }
    expect(fired1).toBe(1);
    expect(trig.snapshot().armed).toBe(false);

    // 高止まりのまま（1350Hz）続けても再発火しない（armed=false のため）。
    let firedWhileHigh = 0;
    for (let i = 0; i < 20; i++) {
      const ev = trig.push(1350, true, t);
      if (ev) firedWhileHigh += 1;
      t += DT;
    }
    expect(firedWhileHigh).toBe(0);
    expect(trig.snapshot().armed).toBe(false);

    // 基準比が閾値未満（1000Hz＝比率1.0）に戻る → armed=true に復帰。
    for (let i = 0; i < 4; i++) {
      trig.push(1000, true, t);
      t += DT;
    }
    expect(trig.snapshot().armed).toBe(true);

    // 再度 +35% へ上げると発火する。
    let fired2 = 0;
    for (let i = 0; i < 6; i++) {
      const ev = trig.push(1350, true, t);
      if (ev) fired2 += 1;
      t += DT;
    }
    expect(fired2).toBe(1);
  });
});

// --- 発火経路の既定停止（2026-07-18 Round 1 実測）------------------------------
// 重心トリガーは通常発話の 92% の時間で基準比 1.3 を超え、誤発火の 78% を占めたため、
// 既定（enabled:false）では発火しない。ただし計測（sample()/snapshot()）は継続する。

describe("CentroidTrigger: 発火経路の既定停止（enabled:false）", () => {
  it("DEFAULT_CENTROID_PARAMS.enabled は false（既定停止）", () => {
    expect(DEFAULT_CENTROID_PARAMS.enabled).toBe(false);
  });

  it("既定（enabled 未指定）では発火条件を満たしても一切発火しない", () => {
    const trig = new CentroidTrigger(); // 既定＝停止中
    let t = 0;
    // 基準 1000Hz を確立。
    for (let i = 0; i < 40; i++) {
      trig.push(1000, true, t);
      t += DT;
    }
    // +35%（1350Hz）を長く（発火条件を余裕で満たす長さ）投入しても発火しない。
    let fired = 0;
    for (let i = 0; i < 30; i++) {
      const ev = trig.push(1350, true, t);
      if (ev) fired += 1;
      t += DT;
    }
    expect(fired).toBe(0);
  });

  it("停止中でも計測（sample()/snapshot()）は継続する（基準・基準比を観測できる）", () => {
    const trig = new CentroidTrigger(); // 停止中
    let t = 0;
    for (let i = 0; i < 40; i++) {
      trig.push(1000, true, t);
      t += DT;
    }
    trig.push(1300, true, t);
    // 発火はしないが、基準（≈1000）と基準比（≈1.3）は観測できる（Phase B 再設計の材料）。
    const s = trig.sample();
    expect(s.centroidHz).toBe(1300);
    expect(s.riseRatio).toBeCloseTo(1.3, 1);
    expect(trig.snapshot().baselineHz).toBeCloseTo(1000, 0);
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
