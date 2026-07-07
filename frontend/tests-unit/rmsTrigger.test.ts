// RmsTrigger（RMS音圧の発火判定・純粋ロジック）の単体テスト（M2）
//
// 【2026-07-07 実測フィードバックによる調整に追随して更新】
//   - rise 閾値のモード依存化: 仮基準(provisional)=+24dB／発話基準(speech)=+12dB
//     （旧・一律 riseThresholdDb=+6dB を置換）
//   - クールダウン 4s→8s
//   - リアーム条件の追加: 発火後は rise が現行閾値未満に一度戻るまで再発火しない
//     （クールダウンと AND）
//
// 検証観点（指示・docs/detection-params.md 準拠）:
//   1. 上昇が持続すると発火する / 持続不足では発火しない
//   2. クールダウン中は発火しない・クールダウン明けで再発火できる
//   3. 無音（VADゲート未満）では baseline が動かない・発火しない
//   4. 仮初期値: 初回有声サンプルで baseline = min(サンプル値, -32)
//   5. 定常区間のみ学習: rise ≥ 現行モードのしきい値の間は EMA を凍結する
//   6. 非対称追従: 下降 τ=2s（速い）／上昇 τ=8s（遅い）
//   7. シナリオ: 冒頭ギャン泣き即発火→凍結→泣き止み追従→再発火／通常開始回帰／興奮後の静音復帰
//   8. モード別閾値: provisional=+24dB／speech=+12dB がそれぞれ適用される
//   9. リアーム: 発火→高止まり中は再発火しない→下がって再度上がると発火する

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RMS_PARAMS,
  RmsTrigger,
  RollingMedian,
} from "../src/modules/detection/rmsTrigger";

const DT = DEFAULT_RMS_PARAMS.sampleIntervalMs; // 50ms

/**
 * 一定 dB のサンプルを count 回、DT間隔で投入する。発火回数と最終時刻を返す。
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
  it("baseline を確立したうえで、しきい値超えの上昇が sustain 時間続くと発火する（仮基準+24dB）", () => {
    const trig = new RmsTrigger();
    let t = 0;

    // 静かな有声（-40dB）を流す。初回 min(-40,-32)=-40 で baseline=-40。以降ほぼ据え置き。
    const quiet = feed(trig, -40, 120, t); // 120 * 50ms = 6s
    t = quiet.lastMs;
    expect(quiet.fired).toBe(0);

    const base = trig.snapshot(t).baselineDb!;
    expect(base).toBeCloseTo(-40, 0);

    // 声を張る: baseline+24dB 以上（仮基準・-14dB=+26dB）を sustain(150ms=3サンプル) 以上続ける。
    let firedTotal = 0;
    for (let i = 0; i < 10; i++) {
      const ev = trig.push(-14, t);
      if (ev) firedTotal += 1;
      t += DT;
    }
    expect(firedTotal).toBe(1); // クールダウン＋リアームにより1回だけ発火する

    // 発火イベントの中身を確認するため、別インスタンスで単発検証。
    const trig2 = new RmsTrigger();
    let t2 = 0;
    feed(trig2, -40, 120, 0);
    t2 = 120 * DT;
    let ev = null;
    for (let i = 0; i < 6 && !ev; i++) {
      ev = trig2.push(-14, t2);
      t2 += DT;
    }
    expect(ev).not.toBeNull();
    expect(ev!.reason).toBe("rms");
    expect(ev!.rmsRise).toBeGreaterThanOrEqual(DEFAULT_RMS_PARAMS.riseThresholdProvisionalDb);
    expect(ev!.rmsDb).toBeCloseTo(-14, 0);
  });

  it("持続不足（sustain 未満）では発火しない", () => {
    const trig = new RmsTrigger();
    let t = 0;
    feed(trig, -40, 120, 0);
    t = 120 * DT;

    // 上昇を sustain(150ms=3サンプル) 未満（2サンプル=100ms）だけ与え、すぐ静音へ戻す。
    // 仮基準+24dB を超える -14dB を使う。
    let fired = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let i = 0; i < 2; i++) {
        const ev = trig.push(-14, t);
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

  it("クールダウン中（8秒）は連続した上昇でも再発火しない", () => {
    const trig = new RmsTrigger();
    let t = 0;
    feed(trig, -40, 120, 0);
    t = 120 * DT;

    // 大声を長く継続（cooldown=8s=160サンプルより短い120サンプル=6s）。
    let fired = 0;
    for (let i = 0; i < 120; i++) {
      const ev = trig.push(-10, t);
      if (ev) fired += 1;
      t += DT;
    }
    // 最初の1回のみ発火し、クールダウン(8s)中は再発火しない
    //（リアーム未済でもある＝声を張ったままなので二重に抑止される）。
    expect(fired).toBe(1);
  });

  it("クールダウン明け後は再び発火できる（大声→静音→大声）", () => {
    const trig = new RmsTrigger();
    let t = 0;
    feed(trig, -40, 120, 0);
    t = 120 * DT;

    let fired = 0;
    const burst = () => {
      for (let i = 0; i < 8; i++) {
        const ev = trig.push(-10, t);
        if (ev) fired += 1;
        t += DT;
      }
    };
    const silence = (n: number) => {
      for (let i = 0; i < n; i++) {
        trig.push(-70, t); // VAD未満: baseline 据え置き・持続リセット・rise 計算対象外
        t += DT;
      }
    };

    burst(); // 1回目の発火（→ cooldown 8s 開始・armed=false）
    silence(200); // 10s 静音（cooldown 8s を跨ぐ・baseline は不変）
    burst(); // 2回目の発火（静音で rise が閾値未満に戻り armed=true 復帰済み）

    expect(fired).toBe(2);
  });

  it("無音（VADゲート未満）では baseline が更新されず、発火もしない", () => {
    const trig = new RmsTrigger();
    let t = 0;
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

  it("sample() は発火判定と独立に直近の rms_db / rms_rise を返す", () => {
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

    // 声を張った直後は rise が正になる（凍結で baseline は据え置かれる）。
    trig.push(-14, t);
    const risen = trig.sample();
    expect(risen.rmsDb).toBeCloseTo(-14, 0);
    expect(risen.rmsRise).toBeGreaterThan(20);
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
      const ev = trig.push(-10, t);
      if (ev) fired += 1;
      t += DT; // 単発の大声
    }
    expect(fired).toBe(0);
  });

  // --- 静音区間ベース再設計（2026-07-07）: 仮初期値・凍結・非対称τ -------------

  it("仮初期値: 初回有声サンプルで baseline = min(サンプル値, -32)", () => {
    // (A) 冒頭が静かな声（-45dB）→ min(-45,-32) = -45 を採用（平常側に寄る）。
    const quiet = new RmsTrigger();
    quiet.push(-45, 0);
    expect(quiet.snapshot(DT).baselineDb!).toBeCloseTo(-45, 5);

    // (B) 冒頭が大声（-5dB）→ min(-5,-32) = -32（仮値）を採用。
    //     これにより rise = -5 -(-32) = +27dB の大きな上昇が冒頭から取れる。
    const loud = new RmsTrigger();
    loud.push(-5, 0);
    expect(loud.snapshot(DT).baselineDb!).toBeCloseTo(-32, 5);
    expect(loud.sample().rmsRise).toBeCloseTo(27, 0);
  });

  it("定常区間のみ学習: rise ≥ 現行モードのしきい値の間は baseline（EMA）が凍結される（仮基準+24dB）", () => {
    // baseline=-40 を確立してから、大声（-10dB＝rise +30dB）を長く流す。
    // 凍結により baseline はほとんど動かない（発話ピークを平常基準に取り込まない）。
    const trig = new RmsTrigger();
    feed(trig, -40, 120, 0);
    let t = 120 * DT;
    const baseBefore = trig.snapshot(t).baselineDb!;

    for (let i = 0; i < 100; i++) {
      // 5秒間の大声。rise = +30dB ≥ 24dB のため凍結が続く。
      trig.push(-10, t);
      t += DT;
    }
    const snap = trig.snapshot(t);
    expect(snap.frozen).toBe(true); // 凍結中
    // baseline は大声継続中もほぼ据え置き（0.5dB 未満のズレに収まる）。
    expect(Math.abs(snap.baselineDb! - baseBefore)).toBeLessThan(0.5);
  });

  it("非対称追従: 下降 τ=2s は上昇 τ=8s より明確に速い（Phase 1）", () => {
    // 同じ baseline(-30) から、rise が現行閾値未満に収まる小さな段差を与え、
    // 下降方向（-33へ）と上昇方向（-27へ）で 10 サンプル後の追従量を比較する。
    // どちらも |rise|=3dB < 24dB（仮基準閾値）なので凍結されず学習が走る。
    // ※ これは Phase 1（仮基準・非対称 EMA）の性質検証なので、発話累計で Phase 2
    //   （発話基準・改良1）へ切り替わらないよう speechAccumMs=∞ で固定する。
    const P1 = { speechAccumMs: Number.POSITIVE_INFINITY };

    // (下降) baseline=-30 → -33 を 10 サンプル。τ=2s。
    const down = new RmsTrigger(P1);
    down.push(-30, 0); // min(-30,-32)=-32 … これだと基準がズレるので、-32 側から作る
    // baseline を厳密に -30 付近に置くため、-30 を十分流して定常化させる。
    let td = DT;
    for (let i = 0; i < 400; i++) {
      down.push(-30, td);
      td += DT;
    }
    const dBase0 = down.snapshot(td).baselineDb!;
    expect(dBase0).toBeCloseTo(-30, 0);
    for (let i = 0; i < 10; i++) {
      down.push(-33, td);
      td += DT;
    }
    const downMove = dBase0 - down.snapshot(td).baselineDb!; // 正: 下降量

    // (上昇) baseline=-30 → -27 を 10 サンプル。τ=8s。
    const up = new RmsTrigger(P1);
    up.push(-30, 0);
    let tu = DT;
    for (let i = 0; i < 400; i++) {
      up.push(-30, tu);
      tu += DT;
    }
    const uBase0 = up.snapshot(tu).baselineDb!;
    expect(uBase0).toBeCloseTo(-30, 0);
    for (let i = 0; i < 10; i++) {
      up.push(-27, tu);
      tu += DT;
    }
    const upMove = up.snapshot(tu).baselineDb! - uBase0; // 正: 上昇量

    // 下降（τ=2s）は上昇（τ=8s）より明確に速い（理論比 ≈ (1-(1-50/2000)^10)/(1-(1-50/8000)^10) ≈ 3.6倍）。
    expect(downMove).toBeGreaterThan(upMove);
    expect(downMove / upMove).toBeGreaterThan(2.5);
  });

  // --- シナリオテスト（指示 6-a / 6-b / 6-c）---------------------------------

  it("(a) 冒頭ギャン泣き: 仮基準で即発火→泣き声継続中は baseline 凍結→泣き止み追従→再発火", () => {
    const trig = new RmsTrigger();
    let t = 0;

    // 冒頭からギャン泣き（-5dB 連続）。初回 min(-5,-32)=-32 の仮基準に対し rise=+27dB(≥24dB)。
    // sustain(150ms) 到達で即発火する。
    let firedEarly = 0;
    for (let i = 0; i < 6; i++) {
      const ev = trig.push(-5, t);
      if (ev) firedEarly += 1;
      t += DT;
    }
    expect(firedEarly).toBe(1); // 仮基準に対し冒頭から即発火

    const baseAtCryStart = trig.snapshot(t).baselineDb!;

    // 泣き声（-5dB）が継続。rise=+27dB ≥ 24dB のため凍結が続き、baseline はほぼ上がらない。
    // クールダウン(8s=160サンプル)を十分に跨ぐ長さ流す。
    for (let i = 0; i < 200; i++) {
      trig.push(-5, t);
      t += DT;
    }
    const snapDuringCry = trig.snapshot(t);
    expect(snapDuringCry.frozen).toBe(true);
    // 凍結により baseline は泣き声の -5 側へ引き上がらない（据え置き）。
    expect(Math.abs(snapDuringCry.baselineDb! - baseAtCryStart)).toBeLessThan(0.5);
    expect(snapDuringCry.baselineDb!).toBeLessThan(-25); // まだ平常側にある
    // リアーム未済（泣き声が高止まりのまま＝rise が閾値未満に戻っていない）。
    expect(snapDuringCry.armed).toBe(false);

    // 泣き止んで普通の声（-32dB前後）に戻る。rise が閾値未満になり凍結解除→下降τ=2sで速やかに追従。
    for (let i = 0; i < 120; i++) {
      trig.push(-32, t); // 6秒ぶん
      t += DT;
    }
    const snapAfter = trig.snapshot(t);
    expect(snapAfter.frozen).toBe(false); // 学習中に戻る
    expect(snapAfter.armed).toBe(true); // リアーム済みに復帰
    expect(snapAfter.baselineDb!).toBeCloseTo(-32, 0); // 平常 -32 付近まで速やかに追従

    // 再度の大声（-5dB）で発火できる（baseline -32 に対し rise=+27dB）。
    let firedAgain = 0;
    for (let i = 0; i < 6; i++) {
      const ev = trig.push(-5, t);
      if (ev) firedAgain += 1;
      t += DT;
    }
    expect(firedAgain).toBe(1);
  });

  it("(b) 静かな開始→通常発話→発火の従来ケース回帰", () => {
    const trig = new RmsTrigger();
    let t = 0;

    // 静かな開始（-42dB）。初回 min(-42,-32)=-42 で baseline=-42。しばらく定常。
    const quiet = feed(trig, -42, 120, t);
    t = quiet.lastMs;
    expect(quiet.fired).toBe(0);
    expect(trig.snapshot(t).baselineDb!).toBeCloseTo(-42, 0);

    // 通常発話で声を張る（-16dB＝rise +26dB ≥ 24dB）を sustain 続けると発火する。
    let fired = 0;
    for (let i = 0; i < 8; i++) {
      const ev = trig.push(-16, t);
      if (ev) fired += 1;
      t += DT;
    }
    expect(fired).toBe(1);
  });

  it("(c) 長い興奮の後の静音復帰: 下降τ=2sで基準が速やかに降りる（Phase 1）", () => {
    // Phase 1（仮基準・非対称 EMA）の静音復帰を検証する。長時間の一定音圧で
    // Phase 2（発話基準）へ切り替わらないよう speechAccumMs=∞ で固定する。
    const trig = new RmsTrigger({ speechAccumMs: Number.POSITIVE_INFINITY });
    let t = 0;

    // 平常 -30dB を長く流して baseline≈-30 を定常化。
    for (let i = 0; i < 400; i++) {
      trig.push(-30, t);
      t += DT;
    }
    expect(trig.snapshot(t).baselineDb!).toBeCloseTo(-30, 0);

    // 長い興奮: -4dB（rise +26dB ≥ 24dB）を長く継続 → 凍結で baseline は据え置き。
    for (let i = 0; i < 160; i++) {
      trig.push(-4, t);
      t += DT;
    }
    const afterExcite = trig.snapshot(t);
    expect(afterExcite.frozen).toBe(true);
    expect(afterExcite.baselineDb!).toBeCloseTo(-30, 0); // 興奮中は据え置き

    // 静音復帰: 平常より低い -40dB（VAD以上・rise 負）へ。凍結解除＋下降τ=2sで速く降りる。
    // 2秒（40サンプル）で -30 から -40 側へ大きく（少なくとも 5dB 超）降りることを確認する。
    for (let i = 0; i < 40; i++) {
      trig.push(-40, t);
      t += DT;
    }
    const afterQuiet = trig.snapshot(t);
    expect(afterQuiet.frozen).toBe(false);
    const drop = -30 - afterQuiet.baselineDb!; // 正: 降下量
    expect(drop).toBeGreaterThan(5); // 下降τ=2s: 2秒で 5dB 超降りる（理論 ≈ 10*(1-(1-50/2000)^40)≈6.3dB）
  });

  // --- 基準レベルの2段階化（改良1・発話基準）---------------------------------

  it("(a) 発話5秒累計で speech モードへ移行し、基準が話し声レベルへ寄る", () => {
    // ノイズフロア -60 を反映 → 発話ゲート = -60 + 8 = -52dB。
    // 平常の話し声 -35dB（ゲート超え＝発話）を 6 秒（120 サンプル）流す。
    const trig = new RmsTrigger();
    trig.setNoiseFloorDb(-60);
    let t = 0;

    // 最初は provisional（仮基準）。初回 min(-35,-32)=-35 で baseline=-35 付近。
    expect(trig.snapshot(t).mode).toBe("provisional");

    // 5 秒（100 サンプル）到達までは provisional のはず。少し手前（4.5s=90サンプル）で確認。
    for (let i = 0; i < 90; i++) {
      trig.push(-35, t);
      t += DT;
    }
    expect(trig.snapshot(t).mode).toBe("provisional");
    expect(trig.snapshot(t).speechAccumMs).toBeGreaterThanOrEqual(4000);

    // さらに続けて発話累計を 5 秒超へ → speech モードへ移行。
    for (let i = 0; i < 40; i++) {
      trig.push(-35, t);
      t += DT;
    }
    const snap = trig.snapshot(t);
    expect(snap.mode).toBe("speech");
    // 発話中央値（≈-35dB）が算出され、baseline がそこへ寄る（スルー制限で徐々に）。
    expect(snap.speechMedianDb).toBeCloseTo(-35, 0);
    expect(snap.baselineDb!).toBeGreaterThan(-40);
    expect(snap.baselineDb!).toBeLessThan(-30);
  });

  it("(b) 背景音レベルの変動では基準が動かない（発話ゲートで弾かれる）", () => {
    // ノイズフロア -55 → 発話ゲート = -47dB。背景音 -50dB は「非発話」＝窓に入らない。
    const trig = new RmsTrigger();
    trig.setNoiseFloorDb(-55);
    let t = 0;

    // まず話し声 -30dB を 6 秒流して speech モード・baseline≈-30 を作る。
    for (let i = 0; i < 120; i++) {
      trig.push(-30, t);
      t += DT;
    }
    expect(trig.snapshot(t).mode).toBe("speech");
    const baseBefore = trig.snapshot(t).baselineDb!;
    const medBefore = trig.snapshot(t).speechMedianDb!;

    // 背景音レベルの上下（-50〜-48dB＝発話ゲート -47 未満）を長く流す。
    // これらは非発話なので発話中央値に入らず、baseline も動かない（VADゲート -55 は通るが
    // 発話ゲートで弾かれるため median 窓に入らない）。
    for (let i = 0; i < 400; i++) {
      trig.push(i % 2 === 0 ? -50 : -48, t);
      t += DT;
    }
    const snap = trig.snapshot(t);
    // 発話中央値は据え置き（背景音を取り込んでいない）。
    expect(snap.speechMedianDb).toBeCloseTo(medBefore, 0);
    // baseline も -30 付近から大きく動かない（背景音で基準が下がっていない）。
    expect(Math.abs(snap.baselineDb! - baseBefore)).toBeLessThan(1);
  });

  it("Phase 2 の基準反映はスルー制限（±1dB/秒）される", () => {
    // speech モードで発話中央値が変わっても、baseline は 1dB/秒までしか動かない。
    // ここでは rise が現行閾値（speech モードは+12dB）未満に収まる段差
    // （-40dB＝baseline -45 に対し +5dB）を与えて凍結を避け、中央値窓に取り込ませたうえで
    // スルー制限を検証する。
    const trig = new RmsTrigger({ speechAccumMs: 0 }); // 即 speech モード
    trig.setNoiseFloorDb(-60); // 発話ゲート -52
    let t = 0;
    // 初回 -45（発話）→ baseline は min(-45,-32)=-45 付近から始まり、median=-45。
    for (let i = 0; i < 20; i++) {
      trig.push(-45, t);
      t += DT;
    }
    const base0 = trig.snapshot(t).baselineDb!;
    // -40dB（rise +5dB < 12dB＝凍結しない）を 20 秒（400サンプル）投入。
    // median は速やかに -40 側へ寄るが、baseline は 1dB/秒のスルー制限で 5dB 動くのに約5秒かかる。
    // 6 秒（120サンプル）時点では最大 6dB しか動けないため、-40 到達前に制限が効く。
    for (let i = 0; i < 120; i++) {
      trig.push(-40, t);
      t += DT;
    }
    const movedAt6s = trig.snapshot(t).baselineDb! - base0; // 上昇量（6秒時点）
    // 6 秒 × 1dB/秒 = 最大 6dB。制限が効いていれば movedAt6s ≤ 6dB 強に収まる。
    expect(movedAt6s).toBeLessThanOrEqual(6.5);
    expect(movedAt6s).toBeGreaterThan(4); // 制限内で確かに追従はしている
    // さらに流し続ければ最終的に median(-40) へ収束する。
    for (let i = 0; i < 400; i++) {
      trig.push(-40, t);
      t += DT;
    }
    expect(trig.snapshot(t).baselineDb!).toBeCloseTo(-40, 0);
  });

  // --- rise 閾値のモード依存化（2026-07-07）-----------------------------------

  it("モード別閾値: provisional モードでは +24dB 未満は発火せず、+24dB 以上で発火する", () => {
    // 発話累計で speech モードへ切り替わらないよう speechAccumMs=∞ で provisional に固定する。
    const trig = new RmsTrigger({ speechAccumMs: Number.POSITIVE_INFINITY });
    let t = 0;
    feed(trig, -40, 120, 0); // baseline≈-40 を確立（provisional のまま）
    t = 120 * DT;
    expect(trig.snapshot(t).mode).toBe("provisional");
    expect(trig.snapshot(t).riseThresholdDb).toBe(24);

    // +20dB（provisional 閾値未満）では発火しない。
    let firedUnder = 0;
    for (let i = 0; i < 8; i++) {
      const ev = trig.push(-20, t);
      if (ev) firedUnder += 1;
      t += DT;
    }
    expect(firedUnder).toBe(0);

    // 静音へ戻して持続をリセット。
    for (let i = 0; i < 6; i++) {
      trig.push(-42, t);
      t += DT;
    }

    // +24dB を明確に超える（-10dB）なら発火する
    //（直前の -20dB 投入で baseline がわずかに上昇EMA分動くため、余裕を持たせた値を使う）。
    let firedOver = 0;
    for (let i = 0; i < 8; i++) {
      const ev = trig.push(-10, t);
      if (ev) firedOver += 1;
      t += DT;
    }
    expect(firedOver).toBe(1);
  });

  it("モード別閾値: speech モードでは +12dB で発火する（provisional なら発火しない上昇幅）", () => {
    // speech モードへ即切替（speechAccumMs=0）。ノイズフロア設定で発話ゲートを有効化。
    const trig = new RmsTrigger({ speechAccumMs: 0 });
    trig.setNoiseFloorDb(-60); // 発話ゲート -52dB
    let t = 0;
    // 平常話し声 -35dB を流して baseline を -35 付近に定常化。
    for (let i = 0; i < 120; i++) {
      trig.push(-35, t);
      t += DT;
    }
    const snap = trig.snapshot(t);
    expect(snap.mode).toBe("speech");
    expect(snap.riseThresholdDb).toBe(12);

    // +15dB（-20dB）は speech 閾値(+12dB)を超えるが provisional 閾値(+24dB)には満たない。
    // speech モードなら発火する。
    let fired = 0;
    for (let i = 0; i < 8; i++) {
      const ev = trig.push(-20, t);
      if (ev) fired += 1;
      t += DT;
    }
    expect(fired).toBe(1);
  });

  // --- リアーム条件（2026-07-07 追加）-----------------------------------------

  it("リアーム: 発火→高止まり中は再発火しない→rise が閾値未満に下がって再度上がると発火する", () => {
    const trig = new RmsTrigger();
    let t = 0;
    feed(trig, -40, 120, 0); // baseline≈-40（provisional・閾値+24dB）
    t = 120 * DT;

    // 1回目発火（-10dB＝rise+30dB）。
    let fired1 = 0;
    for (let i = 0; i < 4; i++) {
      const ev = trig.push(-10, t);
      if (ev) fired1 += 1;
      t += DT;
    }
    expect(fired1).toBe(1);
    expect(trig.snapshot(t).armed).toBe(false);

    // クールダウン(8s)を飛び越えるが、rise が閾値未満に戻っていない（高止まり）ため、
    // 長時間クールダウンを空けても armed が復帰するまでは再発火しない。
    for (let i = 0; i < 200; i++) {
      // 10秒ぶん、声を張ったまま（-10dB のまま高止まり）。
      trig.push(-10, t);
      t += DT;
    }
    // クールダウン(8s=160サンプル)は明けているが、armed=false のため発火していないはず。
    expect(trig.snapshot(t).triggerCount).toBe(1); // 増えていない
    expect(trig.snapshot(t).armed).toBe(false); // rise はまだ閾値以上（高止まり）で未リアーム

    // 静音へ戻す（rise が閾値未満に戻る）→ armed=true に復帰。
    for (let i = 0; i < 10; i++) {
      trig.push(-42, t);
      t += DT;
    }
    expect(trig.snapshot(t).armed).toBe(true);

    // 再度上げると発火する（クールダウンも明けている）。
    let fired2 = 0;
    for (let i = 0; i < 4; i++) {
      const ev = trig.push(-10, t);
      if (ev) fired2 += 1;
      t += DT;
    }
    expect(fired2).toBe(1);
    expect(trig.snapshot(t).triggerCount).toBe(2);
  });
});

describe("RollingMedian（発話中央値ローリング窓・改良1/2 共通）", () => {
  it("窓内の中央値を返し、窓外（windowMs より古い）を落とす", () => {
    const m = new RollingMedian(1000); // 1 秒窓
    m.push(10, 0);
    m.push(20, 100);
    m.push(30, 200);
    expect(m.median()).toBe(20); // [10,20,30] の中央
    // 1.3 秒時点で push すると、0ms/100ms/200ms のサンプルは窓外（<300ms）で落ちる。
    m.push(100, 1300);
    expect(m.size()).toBe(1);
    expect(m.median()).toBe(100);
  });

  it("偶数個は中央2要素の平均、空なら null", () => {
    const m = new RollingMedian(10000);
    expect(m.median()).toBeNull();
    m.push(10, 0);
    m.push(20, 10);
    expect(m.median()).toBe(15);
  });
});
