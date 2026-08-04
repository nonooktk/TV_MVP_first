// Service Worker 定期更新の単体テスト（T4 悲観レビュー M-6）。
//
// 無人待受端末はナビゲーションが起きないため、update() を自前で回さないと sw.js の修正が
// 届かない。ここでは「間隔どおりに呼ばれること」「停止で止まること」「失敗しても
// タイマーが死なないこと」を fake timers で検証する。

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SW_UPDATE_INTERVAL_MS,
  startServiceWorkerUpdates,
  type ServiceWorkerRegistrationLike,
} from "../src/modules/swUpdateScheduler";

afterEach(() => {
  vi.useRealTimers();
});

describe("startServiceWorkerUpdates", () => {
  it("既定は 1 時間間隔である", () => {
    expect(SW_UPDATE_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it("開始直後には呼ばず、間隔ごとに update() を呼ぶ", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const reg: ServiceWorkerRegistrationLike = {
      update: async () => {
        calls += 1;
      },
    };

    const stop = startServiceWorkerUpdates(reg);
    // 登録直後はブラウザが取りに行ったばかりなので、即時チェックはしない。
    expect(calls).toBe(0);

    await vi.advanceTimersByTimeAsync(SW_UPDATE_INTERVAL_MS);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(SW_UPDATE_INTERVAL_MS * 3);
    expect(calls).toBe(4);

    stop();
  });

  it("停止関数でタイマーが止まる", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const reg: ServiceWorkerRegistrationLike = {
      update: async () => {
        calls += 1;
      },
    };

    const stop = startServiceWorkerUpdates(reg);
    await vi.advanceTimersByTimeAsync(SW_UPDATE_INTERVAL_MS);
    expect(calls).toBe(1);

    stop();
    await vi.advanceTimersByTimeAsync(SW_UPDATE_INTERVAL_MS * 5);
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("update() が reject しても次の周期は動き続ける（オフライン想定）", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const reg: ServiceWorkerRegistrationLike = {
      update: async () => {
        calls += 1;
        throw new Error("network error");
      },
    };

    const stop = startServiceWorkerUpdates(reg);
    await vi.advanceTimersByTimeAsync(SW_UPDATE_INTERVAL_MS * 3);

    expect(calls).toBe(3);
    stop();
  });

  it("update() が同期 throw しても止まらない", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const reg: ServiceWorkerRegistrationLike = {
      update: () => {
        calls += 1;
        throw new Error("invalid state");
      },
    };

    const stop = startServiceWorkerUpdates(reg);
    await vi.advanceTimersByTimeAsync(SW_UPDATE_INTERVAL_MS * 2);

    expect(calls).toBe(2);
    stop();
  });

  it("間隔を指定できる（テスト・将来の調整用）", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const reg: ServiceWorkerRegistrationLike = {
      update: async () => {
        calls += 1;
      },
    };

    const stop = startServiceWorkerUpdates(reg, 1000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(calls).toBe(3);
    stop();
  });
});
