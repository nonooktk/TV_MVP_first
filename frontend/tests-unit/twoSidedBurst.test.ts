// 両側連写（Phase 2）のメタデータ組み立ての単体テスト。
//
// attachDetection 本体（DOM/WebAudio 依存）の結線は Playwright E2E で検証するため、
// ここでは純粋ヘルパ toPhotoRecords（連写結果 → IndexedDB 保存レコード変換）を対象に、
//   - stream（"elder"/"family"）の付与
//   - 両側連写の枚数（elder 10 + family 10 = 20＋各 look-back）
//   - face_score のストリーム別扱い（elder=0 / family=コマ別）
// を検証する（両側連写の「stream付与・枚数」の契約テスト）。

import { describe, expect, it } from "vitest";
import { toPhotoRecords } from "../src/modules/detection";
import type { BurstPhoto } from "../src/modules/detection/burst";
import type { CaptureMetadata } from "../src/modules/detection/storage";

/** ダミーの BurstPhoto を作る（blob は空 Blob）。 */
function photo(
  lookback: boolean,
  faceScore: number | undefined,
  rmsDb: number | undefined,
  capturedAtMs = 1000
): BurstPhoto {
  return {
    blob: new Blob([], { type: "image/jpeg" }),
    capturedAtMs,
    lookback,
    faceScore,
    rms: rmsDb === undefined ? undefined : { rmsDb, rmsRise: 5 },
  };
}

const BASE_META: CaptureMetadata = {
  rms_db: -20,
  rms_rise: 8,
  face_score: 0.5, // baseMeta の face_score（family 発火時点の facePipeline スコア）
  trigger_reason: "face",
  trigger_source: "family",
};

describe("両側連写: stream 付与", () => {
  it("elder バーストは全コマ stream='elder'、family バーストは全コマ stream='family'", () => {
    const elderPhotos = [photo(false, undefined, -22), photo(true, undefined, -20)];
    const familyPhotos = [photo(false, 0.8, -30), photo(true, 0.5, -28)];

    const elder = toPhotoRecords("call-1", elderPhotos, BASE_META, "elder", 0);
    const family = toPhotoRecords("call-1", familyPhotos, BASE_META, "family", 0.5);

    expect(elder.every((r) => r.metadata.stream === "elder")).toBe(true);
    expect(family.every((r) => r.metadata.stream === "family")).toBe(true);
  });

  it("trigger_reason / trigger_source など baseMeta は各コマに引き継がれる", () => {
    const recs = toPhotoRecords("call-1", [photo(false, 0.9, -30)], BASE_META, "family", 0.5);
    expect(recs[0].metadata.trigger_reason).toBe("face");
    expect(recs[0].metadata.trigger_source).toBe("family");
    expect(recs[0].callId).toBe("call-1");
  });
});

describe("両側連写: face_score のストリーム別扱い", () => {
  it("elder コマの face_score は 0（fallback=0・コマ別採点も 0 を渡す）", () => {
    // index.ts は elder バーストで sampleFaceScore=()=>0 を渡すため faceScore=0。
    // look-back コマ（faceScore 未設定）は fallbackFaceScore=0 になる。
    const elderPhotos = [photo(false, 0, -22), photo(true, undefined, -20)];
    const recs = toPhotoRecords("call-1", elderPhotos, BASE_META, "elder", 0);
    expect(recs[0].metadata.face_score).toBe(0);
    expect(recs[1].metadata.face_score).toBe(0); // look-back も 0
  });

  it("family コマの face_score はコマ別の値、look-back は fallback（発火時点値）を採る", () => {
    const familyPhotos = [photo(false, 0.83, -30), photo(true, undefined, -28)];
    const recs = toPhotoRecords("call-1", familyPhotos, BASE_META, "family", 0.5);
    expect(recs[0].metadata.face_score).toBeCloseTo(0.83, 5); // コマ別
    expect(recs[1].metadata.face_score).toBeCloseTo(0.5, 5); // look-back は fallback
  });
});

describe("両側連写: 枚数（1発火=両側から連写10枚ずつ＋各 look-back）", () => {
  it("elder 10 + family 10 = 20 の連写＋各 look-back が混在して積まれる", () => {
    // 連写10枚（lookback=false）＋ look-back 3枚（lookback=true）を各ストリームで作る。
    const mkBurst = (face: number | undefined): BurstPhoto[] => [
      ...Array.from({ length: 3 }, () => photo(true, face, -25)),
      ...Array.from({ length: 10 }, () => photo(false, face, -25)),
    ];
    const elder = toPhotoRecords("c", mkBurst(0), BASE_META, "elder", 0);
    const family = toPhotoRecords("c", mkBurst(0.7), BASE_META, "family", 0.7);
    const all = [...elder, ...family];

    const burst = all.filter((r) => r.metadata.lookback !== true).length;
    expect(burst).toBe(20); // 連写は両側合わせて 20 枚
    expect(all.filter((r) => r.metadata.stream === "elder").length).toBe(13);
    expect(all.filter((r) => r.metadata.stream === "family").length).toBe(13);
    // 両ストリームが混在して積まれている。
    expect(new Set(all.map((r) => r.metadata.stream))).toEqual(new Set(["elder", "family"]));
  });
});
