// FacePipeline の health（稼働可視化）ステート機の単体テスト
//
// 検証観点:
//   1. 初期状態は loading（ロード前）
//   2. MediaPipe のロードに失敗すると failed（例外は投げない＝best-effort）
//   3. failed 時も score() は 0 を返し続ける（検知全体を止めない）
//   4. 【修正1】起動から START_TIMEOUT_MS 経過しても loading のままなら failed（理由付き）へ
//      終端する（無限「起動中」を廃止）。
//   5. 【修正1】ロード失敗は起動タイムアウトを待たず即 failed（理由付き）になる。
//
// 実際の推論（detectForVideo）は WASM/モデルを要するため E2E 側。ここでは
// ロード失敗経路・起動タイムアウト・health のステートのみを検証する。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FacePipeline as FacePipelineType,
  START_TIMEOUT_MS as StartTimeoutType,
} from "../src/modules/detection/facePipeline";

function makeFakeVideo() {
  return { videoWidth: 640, videoHeight: 480 } as unknown as HTMLVideoElement;
}

// 各テストは start() 内で `await import("@mediapipe/tasks-vision")` する。テスト間で
// doMock が漏れる（dynamic import のモジュールキャッシュが残る）と誤判定になるため、
// **テストごとに vi.resetModules() したうえで FacePipeline を dynamic import** し、
// その時点の doMock で依存が再評価されるようにする。
type FaceMod = {
  FacePipeline: typeof FacePipelineType;
  START_TIMEOUT_MS: typeof StartTimeoutType;
};
async function loadFaceModule(): Promise<FaceMod> {
  vi.resetModules();
  return (await import("../src/modules/detection/facePipeline")) as FaceMod;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@mediapipe/tasks-vision");
});

describe("FacePipeline.health（表情検知の稼働可視化）", () => {
  it("ロード前は loading", async () => {
    const { FacePipeline } = await loadFaceModule();
    const fp = new FacePipeline(makeFakeVideo());
    expect(fp.health().state).toBe("loading");
    expect(fp.status().loaded).toBe(false);
  });

  it("MediaPipe のロード失敗で failed になり、例外は投げず score は 0（理由付き）", async () => {
    // @mediapipe/tasks-vision を、WASM 解決で失敗するモックへ差し替える
    // （FilesetResolver.forVisionTasks が投げる＝実機の配信失敗に相当）。
    vi.doMock("@mediapipe/tasks-vision", () => ({
      FilesetResolver: {
        forVisionTasks: async () => {
          throw new Error("WASM/モデルの配信に失敗（404 等）");
        },
      },
      FaceLandmarker: { createFromOptions: async () => ({}) },
    }));

    const { FacePipeline } = await loadFaceModule();
    const fp = new FacePipeline(makeFakeVideo());
    // start() は throw しない（best-effort）。
    await expect(fp.start()).resolves.toBeUndefined();

    expect(fp.status().failed).toBe(true);
    const h = fp.health();
    expect(h.state).toBe("failed");
    // 失敗理由が付く（バッジのツールチップ・ログ用）。
    expect(h.reason).toBeTruthy();
    // 検知全体を止めない: score は 0 のまま。
    expect(fp.score()).toBe(0);
    fp.stop();

    vi.doUnmock("@mediapipe/tasks-vision");
  });

  it("【修正1】ロードがハングしても START_TIMEOUT_MS 後に failed（理由付き）へ終端する", async () => {
    // ロードが永遠に解決しない（本番配信のハングを模す）。
    vi.doMock("@mediapipe/tasks-vision", () => ({
      FilesetResolver: {
        // 解決しない Promise（await で無限に待つ）。
        forVisionTasks: () => new Promise(() => {}),
      },
      FaceLandmarker: { createFromOptions: async () => ({}) },
    }));

    // モジュールは fake timers を張る前に読み込む（dynamic import を確実に解決させる）。
    const { FacePipeline, START_TIMEOUT_MS } = await loadFaceModule();
    vi.useFakeTimers();

    const fp = new FacePipeline(makeFakeVideo());
    void fp.start(); // await しない（ロードは解決しないため）

    // タイムアウト前は loading。
    expect(fp.health().state).toBe("loading");

    // START_TIMEOUT_MS を経過させる → 起動タイムアウトのタイマが発火。
    vi.advanceTimersByTime(START_TIMEOUT_MS + 10);

    const h = fp.health();
    expect(h.state).toBe("failed");
    expect(h.reason).toContain("ロード");
    // 無限「起動中」を廃止: loading では固まらない。
    expect(h.state).not.toBe("loading");
    fp.stop();

    vi.doUnmock("@mediapipe/tasks-vision");
  });

  it("【CDN配信】CDN からロード成功で loaded＝true・source＝cdn（本番の SWA throttle 回避）", async () => {
    // FilesetResolver に渡された wasmBase を記録し、CDN パス（jsdelivr）が使われることを確認。
    const seenBases: string[] = [];
    vi.doMock("@mediapipe/tasks-vision", () => ({
      FilesetResolver: {
        forVisionTasks: async (base: string) => {
          seenBases.push(base);
          return {};
        },
      },
      FaceLandmarker: { createFromOptions: async () => ({}) },
    }));

    const { FacePipeline } = await loadFaceModule();
    const fp = new FacePipeline(makeFakeVideo());
    await fp.start();

    const st = fp.status();
    expect(st.loaded).toBe(true);
    expect(st.failed).toBe(false);
    expect(st.source).toBe("cdn");
    // 1回目（＝採用）の wasmBase は CDN（jsdelivr）である。
    expect(seenBases[0]).toContain("cdn.jsdelivr.net");
    fp.stop();

    vi.doUnmock("@mediapipe/tasks-vision");
  });

  it("【CDN配信】CDN 失敗時はローカル /mediapipe へ fallback して loaded＝true・source＝local", async () => {
    // 1回目（CDN）は失敗、2回目（ローカル）は成功するモック。
    let call = 0;
    const seenBases: string[] = [];
    vi.doMock("@mediapipe/tasks-vision", () => ({
      FilesetResolver: {
        forVisionTasks: async (base: string) => {
          seenBases.push(base);
          call += 1;
          if (call === 1) throw new Error("CDN 到達不可");
          return {};
        },
      },
      FaceLandmarker: { createFromOptions: async () => ({}) },
    }));

    const { FacePipeline } = await loadFaceModule();
    const fp = new FacePipeline(makeFakeVideo());
    await fp.start();

    const st = fp.status();
    expect(st.loaded).toBe(true);
    expect(st.source).toBe("local");
    // 1回目=CDN、2回目=ローカル配信パス。
    expect(seenBases[0]).toContain("cdn.jsdelivr.net");
    expect(seenBases[1]).toBe("/mediapipe/wasm");
    fp.stop();

    vi.doUnmock("@mediapipe/tasks-vision");
  });

  it("【修正1】health() は時刻ベースでも終端する（タイマ未発火でも loading で固まらない）", async () => {
    // タイマを進めずに、health(nowMs) へ「START_TIMEOUT_MS 経過後の時刻」を渡す。
    vi.doMock("@mediapipe/tasks-vision", () => ({
      FilesetResolver: { forVisionTasks: () => new Promise(() => {}) },
      FaceLandmarker: { createFromOptions: async () => ({}) },
    }));

    const { FacePipeline, START_TIMEOUT_MS } = await loadFaceModule();
    const fp = new FacePipeline(makeFakeVideo());
    void fp.start();

    // start() 直後は loading（now = 現在時刻）。
    expect(fp.health(Date.now()).state).toBe("loading");
    // now を START_TIMEOUT_MS + 1s 進めた時刻で問い合わせると failed へ。
    const later = Date.now() + START_TIMEOUT_MS + 1000;
    const h = fp.health(later);
    expect(h.state).toBe("failed");
    expect(h.reason).toBeTruthy();
    fp.stop();

    vi.doUnmock("@mediapipe/tasks-vision");
  });
});
