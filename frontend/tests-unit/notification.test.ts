// 記録通知の2段階化（改良3）＋共有クールダウン（重心含む）の契約テスト。
//
// DOM/WebAudio を要する attachDetection 全体は Playwright E2E で検証する方針のため、
// ここでは handleTrigger の「2段階 onEvent（started 即時 → completed 実枚数）」と
// 「reason をまたぐ共有クールダウン（rms/stt/centroid）」の契約ロジックを、
// captureTimeout.test.ts と同様に骨格を再現して検証する。

import { describe, expect, it } from "vitest";
import { passesSharedCooldown } from "../src/modules/detection/sttConfig";

type Reason = "rms" | "stt" | "face" | "centroid";
type Event =
  | { type: "started"; reason: Reason }
  | { type: "completed"; reason: Reason; photoCount: number };

describe("記録通知の2段階化（改良3）", () => {
  it("started はトリガー瞬間に即時、completed は保存完了時に実枚数で通知される", async () => {
    const events: Event[] = [];
    const onEvent = (ev: Event) => events.push(ev);

    // handleTrigger の 2段階通知部分を再現（started を保存前に、completed を保存後に）。
    async function handleTriggerLike(
      reason: Reason,
      save: () => Promise<number> // 保存できた枚数を返す（部分保存もあり得る）
    ): Promise<void> {
      onEvent({ type: "started", reason }); // 即時
      const photoCount = await save();
      if (photoCount > 0) onEvent({ type: "completed", reason, photoCount });
    }

    // 保存が「10枚」成功する通常発火。
    await handleTriggerLike("rms", async () => 10);
    // 8秒タイムアウトの部分保存を模す（実際に保存できたのは 6枚）。
    await handleTriggerLike("centroid", async () => 6);

    expect(events).toEqual([
      { type: "started", reason: "rms" },
      { type: "completed", reason: "rms", photoCount: 10 },
      { type: "started", reason: "centroid" }, // 重心発火でも started が即時に出る
      { type: "completed", reason: "centroid", photoCount: 6 }, // 部分保存でも実枚数
    ]);
  });

  it("started は必ず出るが、保存 0 枚なら completed は出ない", async () => {
    const events: Event[] = [];
    const onEvent = (ev: Event) => events.push(ev);
    async function handleTriggerLike(
      reason: Reason,
      save: () => Promise<number>
    ): Promise<void> {
      onEvent({ type: "started", reason });
      const photoCount = await save();
      if (photoCount > 0) onEvent({ type: "completed", reason, photoCount });
    }
    await handleTriggerLike("rms", async () => 0); // 何も保存できなかった
    expect(events).toEqual([{ type: "started", reason: "rms" }]);
  });
});

describe("共有クールダウン（rms/stt/centroid を横断）", () => {
  const SHARED_COOLDOWN_MS = 4000;

  it("重心発火は直近の RMS 発火から 4 秒間は抑止される（連打防止）", () => {
    // t=0 に RMS 発火（lastTriggerAtMs=0）。
    let lastTriggerAtMs = 0;
    // t=2000（4秒未満）の重心発火は抑止される。
    expect(passesSharedCooldown(2000, lastTriggerAtMs, SHARED_COOLDOWN_MS)).toBe(false);
    // t=4001（4秒経過）なら通過する。
    expect(passesSharedCooldown(4001, lastTriggerAtMs, SHARED_COOLDOWN_MS)).toBe(true);
    // 通過したら lastTriggerAtMs を更新する運用。
    lastTriggerAtMs = 4001;
    // その直後（t=5000）の RMS 発火は再び抑止される。
    expect(passesSharedCooldown(5000, lastTriggerAtMs, SHARED_COOLDOWN_MS)).toBe(false);
  });
});
