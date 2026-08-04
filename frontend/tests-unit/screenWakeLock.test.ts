// 画面消灯抑止（Screen Wake Lock）の単体テスト。
//
// tests-unit は node 環境で DOM を持たないため、startScreenWakeLock の env 引数に
// fake の navigator / document を差し込んで検証する
// （tests-unit/authError.test.ts が window へ最小 Storage を差し込むのと同じ流儀）。
//
// 主眼は ARCHITECTURE §7-1 の遷移「取得 → 非表示で解放 → 表示で再取得 → 停止で解放」と、
// 非対応・失敗時に何も壊さないこと。

import { describe, expect, it } from "vitest";
import {
  startScreenWakeLock,
  type WakeLockDocumentLike,
  type WakeLockNavigatorLike,
  type WakeLockSentinelLike,
} from "../src/modules/screenWakeLock";

/** テスト用の WakeLockSentinel。release() の呼び出しを記録する。 */
class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  releaseCallCount = 0;
  private listeners: Array<() => void> = [];

  release(): Promise<void> {
    this.releaseCallCount += 1;
    this.markReleasedByUA();
    return Promise.resolve();
  }

  addEventListener(_type: "release", listener: () => void): void {
    this.listeners.push(listener);
  }

  /** UA 側の解放（hidden 遷移・省電力）をシミュレートする。 */
  markReleasedByUA(): void {
    if (this.released) return;
    this.released = true;
    for (const listener of this.listeners) listener();
  }
}

/** テスト用の document。visibilityState を任意に切り替えられる。 */
class FakeDocument implements WakeLockDocumentLike {
  visibilityState: string = "visible";
  private listeners: Array<() => void> = [];

  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }

  /** visibilityState を変えてイベントを発火する。 */
  setVisibility(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
  }
}

/** request() のたびに新しい FakeSentinel を返す navigator。 */
function makeNavigator(): {
  nav: WakeLockNavigatorLike;
  sentinels: FakeSentinel[];
  requestCount: () => number;
} {
  const sentinels: FakeSentinel[] = [];
  let count = 0;
  const nav: WakeLockNavigatorLike = {
    wakeLock: {
      request: async (type: "screen") => {
        expect(type).toBe("screen");
        count += 1;
        const s = new FakeSentinel();
        sentinels.push(s);
        return s;
      },
    },
  };
  return { nav, sentinels, requestCount: () => count };
}

// request() の解決（マイクロタスク）を待つ。
const flush = () => Promise.resolve().then(() => undefined);

describe("startScreenWakeLock", () => {
  it("開始時に可視なら Wake Lock を取得する", async () => {
    const { nav, sentinels, requestCount } = makeNavigator();
    const doc = new FakeDocument();

    const stop = startScreenWakeLock({ navigator: nav, document: doc });
    await flush();

    expect(requestCount()).toBe(1);
    expect(sentinels[0].released).toBe(false);
    stop();
  });

  it("非表示で解放され、可視へ戻ると再取得する", async () => {
    const { nav, sentinels, requestCount } = makeNavigator();
    const doc = new FakeDocument();

    const stop = startScreenWakeLock({ navigator: nav, document: doc });
    await flush();
    expect(requestCount()).toBe(1);

    // UA が hidden 遷移で自動解放する（W3C §11.3）挙動を再現する。
    doc.visibilityState = "hidden";
    sentinels[0].markReleasedByUA();
    doc.setVisibility("hidden");
    await flush();
    // hidden 中は取り直さない（request すれば NotAllowedError になるため）。
    expect(requestCount()).toBe(1);

    doc.setVisibility("visible");
    await flush();
    // 可視復帰で再取得されること（ここが抜けると一度隠れただけで永久に効かなくなる）。
    expect(requestCount()).toBe(2);
    expect(sentinels[1].released).toBe(false);

    stop();
  });

  it("停止関数で解放し、visibilitychange リスナーも外す", async () => {
    const { nav, sentinels } = makeNavigator();
    const doc = new FakeDocument();

    const stop = startScreenWakeLock({ navigator: nav, document: doc });
    await flush();
    expect(doc.listenerCount).toBe(1);

    stop();
    await flush();

    expect(sentinels[0].releaseCallCount).toBe(1);
    expect(doc.listenerCount).toBe(0);
  });

  it("停止後は visibilitychange で再取得しない", async () => {
    const { nav, requestCount } = makeNavigator();
    const doc = new FakeDocument();

    const stop = startScreenWakeLock({ navigator: nav, document: doc });
    await flush();
    stop();
    await flush();

    doc.setVisibility("hidden");
    doc.setVisibility("visible");
    await flush();

    expect(requestCount()).toBe(1);
  });

  it("開始時に非表示なら取得しない（可視になってから取得する）", async () => {
    const { nav, requestCount } = makeNavigator();
    const doc = new FakeDocument();
    doc.visibilityState = "hidden";

    const stop = startScreenWakeLock({ navigator: nav, document: doc });
    await flush();
    expect(requestCount()).toBe(0);

    doc.setVisibility("visible");
    await flush();
    expect(requestCount()).toBe(1);

    stop();
  });

  it("既に保持中なら重複して取得しない", async () => {
    const { nav, requestCount } = makeNavigator();
    const doc = new FakeDocument();

    const stop = startScreenWakeLock({ navigator: nav, document: doc });
    await flush();
    expect(requestCount()).toBe(1);

    // 解放を伴わない visible→visible の再通知（UA によっては起こりうる）。
    doc.setVisibility("visible");
    doc.setVisibility("visible");
    await flush();

    expect(requestCount()).toBe(1);
    stop();
  });

  it("非対応ブラウザでは何も登録せず no-op の停止関数を返す", () => {
    const doc = new FakeDocument();
    const nav: WakeLockNavigatorLike = {}; // wakeLock を持たない

    const stop = startScreenWakeLock({ navigator: nav, document: doc });

    expect(doc.listenerCount).toBe(0);
    // 呼んでも例外にならないこと（useEffect のクリーンアップで必ず呼ばれる）。
    expect(() => stop()).not.toThrow();
  });

  it("request() が NotAllowedError で reject しても壊れない", async () => {
    const doc = new FakeDocument();
    const nav: WakeLockNavigatorLike = {
      wakeLock: {
        request: async () => {
          const err = new Error("denied");
          err.name = "NotAllowedError";
          throw err;
        },
      },
    };

    const stop = startScreenWakeLock({ navigator: nav, document: doc });
    await flush();
    await flush();

    // 失敗後も visibilitychange の購読は生きており、停止も安全に行える。
    expect(doc.listenerCount).toBe(1);
    expect(() => stop()).not.toThrow();
    expect(doc.listenerCount).toBe(0);
  });

  it("停止関数を複数回呼んでも解放は1回だけ", async () => {
    const { nav, sentinels } = makeNavigator();
    const doc = new FakeDocument();

    const stop = startScreenWakeLock({ navigator: nav, document: doc });
    await flush();
    stop();
    stop();
    stop();
    await flush();

    expect(sentinels[0].releaseCallCount).toBe(1);
  });

  it("取得の解決前に停止した場合は掴まず即座に解放する", async () => {
    const { nav, sentinels } = makeNavigator();
    const doc = new FakeDocument();

    const stop = startScreenWakeLock({ navigator: nav, document: doc });
    // request() の解決を待たずに停止する（マウント直後のアンマウント）。
    stop();
    await flush();
    await flush();

    // 取りっぱなしにならないこと。
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0].releaseCallCount).toBe(1);
  });
});
