// 発火キャプチャの全体タイムアウト（修正1）の単体テスト（M2）。
//
// 検証観点（指示）:
//   1. raceWithTimeout: settle しない（ハングする）タスクでも timeoutMs で必ず "timeout" を返す
//      （＝呼び出し側は必ず制御を取り戻し busy を解除できる）。
//   2. 「1回目がハングしてタイムアウト → 2回目の発火は正常動作」を、handleTrigger と同型の
//      「busy 再入防止 ＋ raceWithTimeout ＋ finally 解除 ＋ 成功時カウント増加」ループで再現し、
//      連続発火（クールダウン明けの2回目）で triggerCount が増えることを検証する。
//   3. AudioPipeline.buildSnippet の内部タイムアウト: チャンクが一切来なくても maxWaitMs で
//      必ず抜ける（＝根本の「待ち続ける」実装が除去されている）。

import { describe, expect, it, vi } from "vitest";
import { raceWithTimeout } from "../src/modules/detection/index";
import { AudioPipeline } from "../src/modules/detection/audioPipeline";

describe("raceWithTimeout（発火キャプチャ全体タイムアウトの中核）", () => {
  it("ハングするタスクでも timeoutMs で必ず 'timeout' を返す（永久待ちしない）", async () => {
    vi.useFakeTimers();
    // 永久に settle しない Promise（buildSnippet がチャンクを待ち続ける状況を模す）。
    const hang = new Promise<void>(() => {
      /* never resolves */
    });
    const p = raceWithTimeout(hang, 8000);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(p).resolves.toBe("timeout");
    vi.useRealTimers();
  });

  it("時間内に完了すれば 'ok'、例外なら 'error'（投げずに返す）", async () => {
    vi.useFakeTimers();
    const okP = raceWithTimeout(Promise.resolve("done"), 8000);
    const errP = raceWithTimeout(Promise.reject(new Error("boom")), 8000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(okP).resolves.toBe("ok");
    await expect(errP).resolves.toBe("error");
    vi.useRealTimers();
  });

  it("1回目がハング→タイムアウト→2回目は正常発火し triggerCount が増える", async () => {
    vi.useFakeTimers();
    const CAPTURE_TIMEOUT_MS = 8000;

    // handleTrigger の骨格（busy 再入防止＋全体タイムアウト＋finally 解除＋成功時カウント）を再現。
    let busy = false;
    let triggerCount = 0;

    async function handleTriggerLike(capture: () => Promise<void>): Promise<void> {
      if (busy) return; // 再入防止
      busy = true;
      let ok = false;
      try {
        const outcome = await raceWithTimeout(capture(), CAPTURE_TIMEOUT_MS);
        ok = outcome === "ok";
      } finally {
        busy = false; // タイムアウトでも必ず解除（次の発火を生かす）
      }
      if (ok) triggerCount += 1;
    }

    // 1回目: buildSnippet がハングする発火（capture が永久に settle しない）。
    const hangCapture = () =>
      new Promise<void>(() => {
        /* never resolves（buildSnippet ハング相当） */
      });
    const first = handleTriggerLike(hangCapture);
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    await first;

    // 1回目はタイムアウトのため発火カウントは増えないが、busy は解除されている。
    expect(triggerCount).toBe(0);
    expect(busy).toBe(false);

    // 2回目: 正常に完了する発火。busy が解除済みなので再入防止に弾かれず動く。
    const okCapture = () => Promise.resolve();
    const second = handleTriggerLike(okCapture);
    await vi.advanceTimersByTimeAsync(0);
    await second;

    // 2回目は正常動作し triggerCount が増える（＝1回発火後の永久停止が根絶されている）。
    expect(triggerCount).toBe(1);
    expect(busy).toBe(false);

    vi.useRealTimers();
  });
});

describe("AudioPipeline.buildSnippet の内部タイムアウト（修正1）", () => {
  it("チャンクが一切来なくても maxWaitMs で必ず抜ける（待ち続けない）", async () => {
    vi.useFakeTimers();
    const pipeline = new AudioPipeline(
      {} as unknown as MediaStreamTrack,
      () => {},
      { maxWaitMs: 6000, postRollMs: 3000, timesliceMs: 1000 }
    );
    // recorder を「存在するが ondataavailable が発火しない」状態に偽装する。
    // ヘッダも区間チャンクも無いので parts は空 → null を返すが、
    // 重要なのは「6秒（maxWaitMs）で必ず resolve する（ハングしない）」こと。
    // （private フィールドへ直接注入する）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pipeline as any).recorder = { state: "recording" };

    const triggerAtMs = Date.now();
    let settled = false;
    const p = pipeline.buildSnippet(triggerAtMs).then((r) => {
      settled = true;
      return r;
    });

    // 6秒未満では抜けていないこと（maxWaitMs=6000）。
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);

    // 6秒到達で必ず resolve する。
    await vi.advanceTimersByTimeAsync(1200);
    await expect(p).resolves.toBeNull(); // 手元にチャンク無し → null
    expect(settled).toBe(true);

    vi.useRealTimers();
  });

  it("recorder が無ければ即 null（待たない）", async () => {
    const pipeline = new AudioPipeline(
      {} as unknown as MediaStreamTrack,
      () => {}
    );
    await expect(pipeline.buildSnippet(Date.now())).resolves.toBeNull();
  });
});
