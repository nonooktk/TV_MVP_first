// ストレージ永続化申請の単体テスト（T4 悲観レビュー M-3）。
//
// tests-unit は node 環境で navigator.storage を持たないため、env 引数に fake の
// navigator を差し込んで検証する（screenWakeLock.test.ts と同じ流儀）。
//
// 主眼は「申請が実際に呼ばれること」と「非対応・拒否・例外で待受を壊さないこと」。

import { describe, expect, it } from "vitest";
import {
  requestPersistentStorage,
  type PersistentStorageNavigatorLike,
} from "../src/modules/persistentStorage";

describe("requestPersistentStorage", () => {
  it("未永続なら persist() を申請し、許可されたら true を返す", async () => {
    let persistCalls = 0;
    const nav: PersistentStorageNavigatorLike = {
      storage: {
        persisted: async () => false,
        persist: async () => {
          persistCalls += 1;
          return true;
        },
      },
    };

    await expect(requestPersistentStorage({ navigator: nav })).resolves.toBe(true);
    expect(persistCalls).toBe(1);
  });

  it("すでに永続化されていれば persist() を呼ばない", async () => {
    let persistCalls = 0;
    const nav: PersistentStorageNavigatorLike = {
      storage: {
        persisted: async () => true,
        persist: async () => {
          persistCalls += 1;
          return true;
        },
      },
    };

    await expect(requestPersistentStorage({ navigator: nav })).resolves.toBe(true);
    expect(persistCalls).toBe(0);
  });

  it("拒否されたら false を返す（例外にしない）", async () => {
    const nav: PersistentStorageNavigatorLike = {
      storage: {
        persisted: async () => false,
        persist: async () => false,
      },
    };

    await expect(requestPersistentStorage({ navigator: nav })).resolves.toBe(false);
  });

  it("Storage API 非対応なら null を返す", async () => {
    await expect(requestPersistentStorage({ navigator: {} })).resolves.toBeNull();
  });

  it("persist() を持たない実装では null を返す", async () => {
    const nav: PersistentStorageNavigatorLike = {
      storage: { persisted: async () => false },
    };

    await expect(requestPersistentStorage({ navigator: nav })).resolves.toBeNull();
  });

  it("persisted() を持たない実装でも persist() を申請する", async () => {
    let persistCalls = 0;
    const nav: PersistentStorageNavigatorLike = {
      storage: {
        persist: async () => {
          persistCalls += 1;
          return true;
        },
      },
    };

    await expect(requestPersistentStorage({ navigator: nav })).resolves.toBe(true);
    expect(persistCalls).toBe(1);
  });

  it("例外が投げられても握りつぶして null を返す", async () => {
    const nav: PersistentStorageNavigatorLike = {
      storage: {
        persisted: async () => false,
        persist: async () => {
          throw new Error("SecurityError");
        },
      },
    };

    await expect(requestPersistentStorage({ navigator: nav })).resolves.toBeNull();
  });
});
