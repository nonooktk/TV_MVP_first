// 家族側 VAD 床の自動化（item 12）の単体テスト
//
// - AudioPipeline.updateNoiseFloor（ノイズフロア推定→床=ノイズ+8dB・[-50,-45] クランプ。
//   2026-07-10: ノイズゲート（固定 -50dB・rmsTrigger.ts）の追加に伴いクランプ下限を
//   -70→-50 に変更し、「-50dB 未満には絶対反応しない」ことを二重に保証する）
// - RmsTrigger.setVadFloorDb（VAD 床の動的更新が発火判定に反映される）
//
// updateNoiseFloor は純粋な状態遷移（DOM 非依存）なので、ダミートラックで構築して直接叩く。

import { describe, expect, it } from "vitest";
import {
  AudioPipeline,
  DEFAULT_AUDIO_PARAMS,
} from "../src/modules/detection/audioPipeline";
import { RmsTrigger } from "../src/modules/detection/rmsTrigger";

const P = DEFAULT_AUDIO_PARAMS;
const DT = P.rmsIntervalMs; // 50ms

// updateNoiseFloor の検証だけを行うため、track はダミーでよい（メソッドは触れない）。
function makePipeline(): AudioPipeline {
  const dummyTrack = {} as unknown as MediaStreamTrack;
  return new AudioPipeline(dummyTrack, () => {});
}

/** db を count 回 DT 間隔で投入し、返ってきた床（非 null）だけを配列で返す。 */
function feed(
  pipe: AudioPipeline,
  db: number,
  count: number,
  startMs = 0
): { floors: number[]; lastMs: number } {
  const floors: number[] = [];
  let t = startMs;
  for (let i = 0; i < count; i++) {
    const f = pipe.updateNoiseFloor(db, t);
    if (f !== null) floors.push(f);
    t += DT;
  }
  return { floors, lastMs: t };
}

describe("AudioPipeline.updateNoiseFloor（VAD 床の自動化）", () => {
  it("静かな環境ではノイズフロアに追従し 床=ノイズ+8dB を返す", () => {
    const pipe = makePipeline();
    // -54dBFS 一定の静かな環境。十分なサンプルで EMA が -54 へ収束。
    const { floors } = feed(pipe, -54, 400);
    expect(floors.length).toBeGreaterThan(0);
    const last = floors[floors.length - 1];
    // ノイズ -54 + margin 8 = -46（[-50,-45] 内なのでクランプなし）。
    expect(last).toBeCloseTo(-46, 0);
  });

  it("床は下限 -50dB を下回らない（2026-07-10: ノイズゲート固定 -50dB と揃えたクランプ）", () => {
    const pipe = makePipeline();
    // 極端に静か（-100dBFS）→ ノイズ -100 + 8 = -92 だが下限 -50 でクランプ
    // （ノイズゲート固定 -50dB より下には絶対に反応しないことの二重保証）。
    const { floors } = feed(pipe, -100, 400);
    const last = floors[floors.length - 1];
    expect(last).toBeGreaterThanOrEqual(P.vadFloorMinDb - 1e-6);
    expect(last).toBeCloseTo(P.vadFloorMinDb, 5);
    expect(P.vadFloorMinDb).toBe(-50);
  });

  it("床は上限 -45dB を超えない", () => {
    const pipe = makePipeline();
    // うるさい地の音（-30dBFS）→ ノイズ -30 + 8 = -22 だが上限 -45 でクランプ。
    // 上昇は遅い τ なので十分なサンプルを流す。
    const { floors } = feed(pipe, -30, 4000);
    const last = floors[floors.length - 1];
    expect(last).toBeLessThanOrEqual(P.vadFloorMaxDb + 1e-6);
    expect(last).toBeCloseTo(P.vadFloorMaxDb, 5);
  });

  it("更新間隔（1s）未満では床を返さない（推定だけ進む）", () => {
    const pipe = makePipeline();
    // vadFloorUpdateMs=1000ms / DT=50ms = 20サンプル未満では床は出ない。
    const samples = P.vadFloorUpdateMs / DT - 1; // 19
    const { floors } = feed(pipe, -66, samples);
    expect(floors.length).toBe(0);
    // 推定自体は進んでいる。
    expect(pipe.noiseFloorEstimate()).not.toBeNull();
  });

  it("発話（大音圧）はノイズフロアを大きく持ち上げない（非対称EMA・遅い上昇）", () => {
    const pipe = makePipeline();
    // まず静かな地の音で推定を -66 付近へ収束させる。
    feed(pipe, -66, 400);
    const before = pipe.noiseFloorEstimate()!;
    // 短い発話（大音圧 -20dBFS を 20サンプル=1s だけ）。
    feed(pipe, -20, 20, 400 * DT);
    const after = pipe.noiseFloorEstimate()!;
    // 上昇 τ が遅い（8s）ため、1s の発話ではわずかしか持ち上がらない。
    expect(after - before).toBeLessThan(10);
  });
});

describe("RmsTrigger.setVadFloorDb（VAD 床の動的更新）", () => {
  it("床を上げると、それ未満の音は無音扱いになり発火しない", () => {
    const trig = new RmsTrigger();
    // 既定床 -55。床を -30 に上げると -40dB は「無音」扱い。
    trig.setVadFloorDb(-30);
    expect(trig.vadFloorDb()).toBe(-30);
    let fired = 0;
    let t = 0;
    // -40dB（床 -30 未満）を持続投入 → VAD ゲートで常に無音扱い＝発火しない。
    for (let i = 0; i < 200; i++) {
      if (trig.push(-40, t)) fired += 1;
      t += 50;
    }
    expect(fired).toBe(0);
    // baseline も動いていない（無音では更新しない仕様）。
    expect(trig.snapshot(t).baselineDb).toBeNull();
  });

  it("床を下げると、その音は有声扱いになり baseline が確定する", () => {
    const trig = new RmsTrigger();
    trig.setVadFloorDb(-60); // -50dB を有声にする
    trig.push(-50, 0);
    expect(trig.snapshot(50).baselineDb).not.toBeNull();
  });
});
