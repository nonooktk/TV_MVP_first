// captureBurst（連写＋look-back・コマごと face_score 採点）の単体テスト
//
// 検証観点（不具合2の再発防止）:
//   1. sampleFaceScore が各ショットで呼ばれ、コマごとの faceScore が記録される
//      （発火瞬間の1値を全コマで共有しない）
//   2. look-back コマには lookbackFaceScore（発火時点の直近値）が入る
//   3. sampleFaceScore 未指定なら faceScore は付かない（後方互換）
//
// captureBurst は DOM（canvas.toBlob / video.videoWidth）に依存するため、
// 最小のフェイクを注入する（vitest 環境は node）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureBurst, type BurstPhoto } from "../src/modules/detection/burst";
import type { LookbackFrame } from "../src/modules/detection/videoRing";

// --- DOM フェイク --------------------------------------------------------------

function fakeBlob(tag: string): Blob {
  // node 環境の Blob で十分（中身は問わない）。
  return new Blob([tag], { type: "image/jpeg" });
}

/** canvas.toBlob / getContext を持つフェイク canvas。 */
function makeFakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob: (cb: (b: Blob | null) => void) => cb(fakeBlob("shot")),
  };
}

/** videoWidth/Height を持つフェイク video。 */
function makeFakeVideo() {
  return { videoWidth: 640, videoHeight: 480 } as unknown as HTMLVideoElement;
}

beforeEach(() => {
  // document.createElement("canvas") をフェイクへ差し替える。
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag === "canvas") return makeFakeCanvas();
      throw new Error(`unexpected createElement(${tag})`);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- テスト --------------------------------------------------------------------

describe("captureBurst のコマごと face_score 採点", () => {
  it("各ショットで sampleFaceScore を呼び、コマごとの faceScore を記録する", async () => {
    const video = makeFakeVideo();
    // ショットごとに 0.1, 0.2, 0.3 を返す（コマごとに異なる値）。
    const values = [0.1, 0.2, 0.3];
    let i = 0;
    const sampleFaceScore = vi.fn(() => values[Math.min(i++, values.length - 1)]);

    const photos = await captureBurst(
      video,
      [],
      { frames: 3, intervalMs: 0 },
      { sampleFaceScore }
    );

    const shots = photos.filter((p) => !p.lookback);
    expect(shots).toHaveLength(3);
    // 発火瞬間の1値共有ではなく、コマごとに異なる値が入っている。
    expect(shots.map((p: BurstPhoto) => p.faceScore)).toEqual([0.1, 0.2, 0.3]);
    expect(sampleFaceScore).toHaveBeenCalledTimes(3);
  });

  it("look-back コマには lookbackFaceScore（発火時点の直近値）が入る", async () => {
    const video = makeFakeVideo();
    const lookback: LookbackFrame[] = [
      { blob: fakeBlob("lb0"), capturedAtMs: 1000 },
      { blob: fakeBlob("lb1"), capturedAtMs: 1200 },
    ];

    const photos = await captureBurst(
      video,
      lookback,
      { frames: 1, intervalMs: 0 },
      { sampleFaceScore: () => 0.5, lookbackFaceScore: 0.42 }
    );

    const lb = photos.filter((p) => p.lookback);
    expect(lb).toHaveLength(2);
    // look-back は直近値（0.42）を共有する。
    expect(lb.every((p) => p.faceScore === 0.42)).toBe(true);
    // 連写コマは sampleFaceScore（0.5）。
    const shots = photos.filter((p) => !p.lookback);
    expect(shots[0].faceScore).toBe(0.5);
  });

  it("sampleFaceScore 未指定なら faceScore は付かない（後方互換）", async () => {
    const video = makeFakeVideo();
    const photos = await captureBurst(video, [], { frames: 2, intervalMs: 0 });
    expect(photos).toHaveLength(2);
    expect(photos.every((p) => p.faceScore === undefined)).toBe(true);
  });
});

describe("captureBurst のコマごと音圧（rms_db / rms_rise）採点【修正2】", () => {
  it("各ショットで sampleRms を呼び、コマごとに異なる rms を記録する", async () => {
    const video = makeFakeVideo();
    // ショットごとに音圧が変化する（無表情環境でも連写内で差がつくことの再現）。
    const samples = [
      { rmsDb: -40, rmsRise: 2 },
      { rmsDb: -30, rmsRise: 12 },
      { rmsDb: -35, rmsRise: 7 },
    ];
    let i = 0;
    const sampleRms = vi.fn(() => samples[Math.min(i++, samples.length - 1)]);

    const photos = await captureBurst(
      video,
      [],
      { frames: 3, intervalMs: 0 },
      { sampleRms }
    );

    const shots = photos.filter((p) => !p.lookback);
    expect(shots).toHaveLength(3);
    // 発火瞬間の1値共有ではなく、コマごとに異なる rms が入っている。
    expect(shots.map((p) => p.rms?.rmsDb)).toEqual([-40, -30, -35]);
    expect(shots.map((p) => p.rms?.rmsRise)).toEqual([2, 12, 7]);
    // 記録された rms_db が全て同値ではない（＝候補が同点になる原因の解消）。
    expect(new Set(shots.map((p) => p.rms?.rmsDb)).size).toBeGreaterThan(1);
    expect(sampleRms).toHaveBeenCalledTimes(3);
  });

  it("look-back コマには lookbackRms（発火時点の直近値）が入る", async () => {
    const video = makeFakeVideo();
    const lookback: LookbackFrame[] = [
      { blob: fakeBlob("lb0"), capturedAtMs: 1000 },
      { blob: fakeBlob("lb1"), capturedAtMs: 1200 },
    ];

    const photos = await captureBurst(
      video,
      lookback,
      { frames: 1, intervalMs: 0 },
      {
        sampleRms: () => ({ rmsDb: -28, rmsRise: 14 }),
        lookbackRms: { rmsDb: -33, rmsRise: 9 },
      }
    );

    const lb = photos.filter((p) => p.lookback);
    expect(lb).toHaveLength(2);
    // look-back は発火時点の直近値（-33/9）を共有する。
    expect(lb.every((p) => p.rms?.rmsDb === -33 && p.rms?.rmsRise === 9)).toBe(true);
    // 連写コマは sampleRms（-28/14）。
    const shots = photos.filter((p) => !p.lookback);
    expect(shots[0].rms).toEqual({ rmsDb: -28, rmsRise: 14 });
  });

  it("sampleRms 未指定なら rms は付かない（後方互換）", async () => {
    const video = makeFakeVideo();
    const photos = await captureBurst(video, [], { frames: 2, intervalMs: 0 });
    expect(photos).toHaveLength(2);
    expect(photos.every((p) => p.rms === undefined)).toBe(true);
  });
});
