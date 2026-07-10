// 声トリガーの両側化（family lane・2026-07-10 追加）の単体テスト。
//
// attachDetection（modules/detection/index.ts）本体は DOM/WebAudio（AudioContext・
// MediaRecorder・MediaPipe 等）に依存するため、他の M2 実装（captureTimeout.test.ts・
// notification.test.ts）と同じ方針で、DOM 非依存の「純粋ロジック」側を対象に検証する
// （DOM を要する結線そのものは Playwright E2E の対象）。
//
// 検証観点（指示準拠）:
//   1. family lane 独立性: elder レーンと family レーンの RmsTrigger/CentroidTrigger は
//      別インスタンスであり、baseline・sustain・armed・ノイズフロア/VAD床設定のいずれも
//      互いに影響しない（一方の大声・パラメータ変更が他方の状態を動かさない）。
//   2. 共有クールダウンの全系統横断: elder の rms/centroid/stt ＋ family の rms/centroid の
//      どれが発火しても、8秒間は他の系統も含めて再発火が抑止される
//      （index.ts の handleTrigger が実際に使う passesSharedCooldown をそのまま検証する）。

import { describe, expect, it } from "vitest";
import { DEFAULT_RMS_PARAMS, RmsTrigger } from "../src/modules/detection/rmsTrigger";
import { CentroidTrigger } from "../src/modules/detection/centroidTrigger";
import { passesSharedCooldown } from "../src/modules/detection/sttConfig";

const DT = DEFAULT_RMS_PARAMS.sampleIntervalMs; // 50ms

describe("family lane 独立性（elder/family は完全に独立したインスタンス）", () => {
  it("family レーンに大声を流しても elder レーンの baseline・sustain・armed は一切動かない", () => {
    const elderRms = new RmsTrigger();
    const familyRms = new RmsTrigger();
    let t = 0;

    // elder は静かな -40dB で baseline を確立する。
    for (let i = 0; i < 120; i++) {
      elderRms.push(-40, t);
      t += DT;
    }
    const elderBaseline = elderRms.snapshot(t).baselineDb!;
    expect(elderBaseline).toBeCloseTo(-40, 0);

    // family レーンに大声（-5dB）を大量に流して family 側を発火させる。
    let familyFired = 0;
    for (let i = 0; i < 200; i++) {
      const ev = familyRms.push(-5, t);
      if (ev) familyFired += 1;
      t += DT;
    }
    expect(familyFired).toBeGreaterThan(0); // family 側は独立に発火できる

    // elder レーンには一切 push していないので、baseline・sustain・armed は不変のまま。
    const elderAfter = elderRms.snapshot(t);
    expect(elderAfter.baselineDb).toBe(elderBaseline);
    expect(elderAfter.sustainedMs).toBe(0);
    expect(elderAfter.armed).toBe(true);
    expect(elderAfter.triggerCount).toBe(0);
  });

  it("setVadFloorDb / setNoiseFloorDb は自分のインスタンスにしか反映されない（他方に波及しない）", () => {
    const elderRms = new RmsTrigger();
    const familyRms = new RmsTrigger();

    familyRms.setVadFloorDb(-30);
    familyRms.setNoiseFloorDb(-20);

    expect(familyRms.vadFloorDb()).toBe(-30);
    // elder 側は既定値（-55）のまま。family 側の設定が波及していない。
    expect(elderRms.vadFloorDb()).toBe(DEFAULT_RMS_PARAMS.vadFloorDb);
  });

  it("elder/family それぞれの baseline は自分に投入したサンプルのみを反映する", () => {
    const elderRms = new RmsTrigger();
    const familyRms = new RmsTrigger();
    let t = 0;

    // elder=-45dB・family=-35dB を交互に同時刻へ投入する（実運用の2系統同時実行を模す）。
    // どちらも仮初期値 provisionalBaselineDb(-32) より静かな値にして、
    // 初回サンプルの min(サンプル値, -32) がそのまま採用される値にする
    // （baseline の初期化ロジック自体は別テスト＝rmsTrigger.test.ts で検証済み）。
    for (let i = 0; i < 120; i++) {
      elderRms.push(-45, t);
      familyRms.push(-35, t);
      t += DT;
    }

    expect(elderRms.snapshot(t).baselineDb).toBeCloseTo(-45, 0);
    expect(familyRms.snapshot(t).baselineDb).toBeCloseTo(-35, 0);
  });

  it("CentroidTrigger も同様に独立（family の重心上昇は elder の持続・armed に影響しない）", () => {
    const elderCentroid = new CentroidTrigger();
    const familyCentroid = new CentroidTrigger();
    let t = 0;

    // 両者に平常の重心（1000Hz・発話中）を流して基準を作る。
    for (let i = 0; i < 20; i++) {
      elderCentroid.push(1000, true, t);
      familyCentroid.push(1000, true, t);
      t += DT;
    }

    // family だけ重心を跳ね上げて持続を積む（基準比 +30% 超）。
    for (let i = 0; i < 10; i++) {
      familyCentroid.push(1500, true, t);
      t += DT;
    }
    expect(familyCentroid.snapshot().sustainedMs).toBeGreaterThan(0);
    // elder には何も push していないので持続は0のまま。
    expect(elderCentroid.snapshot().sustainedMs).toBe(0);
    expect(elderCentroid.snapshot().armed).toBe(true);
  });
});

describe("共有クールダウン（全系統横断・elder rms/centroid/stt ＋ family rms/centroid）", () => {
  // index.ts の handleTrigger が実際に使う値（DEFAULT_RMS_PARAMS.cooldownMs=8000ms）。
  const SHARED_COOLDOWN_MS = DEFAULT_RMS_PARAMS.cooldownMs;

  // 通話開始からの経過時間ではなく、Date.now() 相当の実時刻ライクな基準点を使う
  // （index.ts の lastTriggerAtMs 初期値は 0＝「未発火」を表すため、t=0 を「発火時刻」に
  // 使うと「未発火からの経過」と区別が付かなくなる。実運用の Date.now() は常に大きい値）。
  const T0 = 1_700_000_000_000;

  it("どの系統が発火しても、8秒間は他系統も含めて再発火が抑止される", () => {
    // handleTrigger 内の lastTriggerAtMs 相当（elder/family 共有の単一変数）を模す。
    // 初期値 0（未発火）からの最初の判定は、実時刻ライクな T0 との差が cooldownMs を
    // 大きく超えるため必ず通過する（index.ts の初回発火と同じ挙動）。
    let lastTriggerAtMs = 0;

    // T0: elder の rms が発火。
    expect(passesSharedCooldown(T0, lastTriggerAtMs, SHARED_COOLDOWN_MS)).toBe(true);
    lastTriggerAtMs = T0;

    // T0+3000（8秒未満）: family の centroid は elder 発火からの共有クールダウンで抑止される。
    expect(passesSharedCooldown(T0 + 3000, lastTriggerAtMs, SHARED_COOLDOWN_MS)).toBe(false);

    // T0+7999（僅かに8秒未満）: elder の stt もまだ抑止される。
    expect(passesSharedCooldown(T0 + 7999, lastTriggerAtMs, SHARED_COOLDOWN_MS)).toBe(false);

    // T0+8000（ちょうど8秒経過）: family の rms は通過する。
    expect(passesSharedCooldown(T0 + 8000, lastTriggerAtMs, SHARED_COOLDOWN_MS)).toBe(true);
    lastTriggerAtMs = T0 + 8000; // family の rms が発火 → 以後は family 起点で共有クールダウンが延長される

    // family 発火から8秒未満: elder の rms も抑止される（family 起点でも横断的に効く）。
    expect(
      passesSharedCooldown(lastTriggerAtMs + 500, lastTriggerAtMs, SHARED_COOLDOWN_MS)
    ).toBe(false);

    // family 発火から8秒経過: elder の centroid が通過する。
    expect(
      passesSharedCooldown(lastTriggerAtMs + 8001, lastTriggerAtMs, SHARED_COOLDOWN_MS)
    ).toBe(true);
  });

  it("family lane が無い（familyAudioTrack 未接続）通話でも、elder 単独の共有クールダウンは従来どおり動く", () => {
    // family lane 相当の呼び出しが一切来ないケース（既存の elder のみの通話）でも
    // 共有クールダウンのロジック自体は変わらないことを確認する（後方互換の回帰確認）。
    let lastTriggerAtMs = 0;
    expect(passesSharedCooldown(T0, lastTriggerAtMs, SHARED_COOLDOWN_MS)).toBe(true);
    lastTriggerAtMs = T0;
    expect(passesSharedCooldown(T0 + 7999, lastTriggerAtMs, SHARED_COOLDOWN_MS)).toBe(false);
    expect(passesSharedCooldown(T0 + 8000, lastTriggerAtMs, SHARED_COOLDOWN_MS)).toBe(true);
  });
});
