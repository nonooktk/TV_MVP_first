// measurementLogStorage（計測ログの永続化層）の単体テスト
//
// fake-indexeddb を import してから対象モジュールを import する（IndexedDB のグローバル実装を
// テスト実行時にのみ提供する。他のテストファイルには一切影響しない＝このファイル内に閉じる）。
//
// 対象モジュールは dbPromise をモジュールスコープでキャッシュしているため、
// テストごとに (a) fake-indexeddb のグローバルを新しいインスタンスへ差し替え、
// (b) vi.resetModules() したうえで dynamic import し直す（facePipeline.test.ts と同じ
// パターン）ことで、テスト間の DB 状態・モジュールキャッシュの混線を防ぐ。
//
// 検証観点（指示準拠）:
//   1. 上限ローテーション（MAX_STORED_CALLS+1件目の保存で最古が消える）
//   2. フラッシュのマージ整合性（同一 call_id への複数回フラッシュで矛盾なく最新化される。
//      10秒フラッシュ→通話終了確定保存の順で呼んでも整合すること。逆順でも整合すること）
//   3. 一覧取得（updatedAt 降順で返る）
//   4. 削除

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeasurementLog } from "../src/modules/detection/measurementLog";
import { DEFAULT_RMS_PARAMS } from "../src/modules/detection/rmsTrigger";
import { DEFAULT_CENTROID_PARAMS } from "../src/modules/detection/centroidTrigger";
import type { MeasurementLogExport } from "../src/modules/detection/measurementLog";
import type * as MeasurementLogStorageModule from "../src/modules/detection/measurementLogStorage";

const PARAMS = { rms: DEFAULT_RMS_PARAMS, centroid: DEFAULT_CENTROID_PARAMS };

/** テスト用のダミー MeasurementLogExport を作る（samples/events 件数を指定できる）。 */
function makeExport(
  callId: string,
  opts: { samples?: number; events?: number } = {}
): MeasurementLogExport {
  const log = new MeasurementLog(callId, PARAMS, 0);
  const sampleCount = opts.samples ?? 0;
  for (let i = 0; i < sampleCount; i++) {
    log.tick(
      {
        rms: {
          baselineDb: -32,
          lastRmsDb: -20,
          sustainedMs: 0,
          inCooldown: false,
          triggerCount: 0,
          riseDb: 12,
          cooldownRemainingMs: 0,
          vadFloorDb: -55,
          noiseGateDb: -50,
          gated: false,
          frozen: false,
          riseThresholdDb: 24,
          armed: true,
          mode: "provisional",
          speechAccumMs: 0,
          speechMedianDb: null,
          pendingConfirm: false,
          spikeRejectedCount: 0,
        },
        centroid: {
          lastCentroidHz: 1200,
          baselineHz: 1000,
          riseRatio: 1.2,
          sustainedMs: 0,
          armed: true,
        },
        noiseFloorDb: null,
        autoGainDb: null,
      },
      (i + 1) * 1000
    );
  }
  const eventCount = opts.events ?? 0;
  for (let i = 0; i < eventCount; i++) {
    log.recordTriggerStart(
      "rms",
      {
        baselineDb: -32,
        lastRmsDb: -20,
        sustainedMs: 0,
        inCooldown: false,
        triggerCount: 0,
        riseDb: 12,
        cooldownRemainingMs: 0,
        vadFloorDb: -55,
        noiseGateDb: -50,
        gated: false,
        frozen: false,
        riseThresholdDb: 24,
        armed: true,
        mode: "provisional",
        speechAccumMs: 0,
        speechMedianDb: null,
        pendingConfirm: false,
        spikeRejectedCount: 0,
      },
      {
        lastCentroidHz: 1200,
        baselineHz: 1000,
        riseRatio: 1.2,
        sustainedMs: 0,
        armed: true,
      },
      null,
      (i + 1) * 1000
    );
    log.recordTriggerComplete(1, false);
  }
  return log.toExport(999999);
}

/** テストごとに IndexedDB を新規にし、モジュールを再取得する。 */
async function freshModule(): Promise<typeof MeasurementLogStorageModule> {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.resetModules();
  return import("../src/modules/detection/measurementLogStorage");
}

beforeEach(() => {
  vi.resetModules();
});

describe("measurementLogStorage", () => {
  it("flushMeasurementLog → listMeasurementLogs で1件保存され件数が確認できる", async () => {
    const { flushMeasurementLog, listMeasurementLogs } = await freshModule();
    await flushMeasurementLog(makeExport("call-a", { samples: 3, events: 1 }));
    const items = await listMeasurementLogs();
    expect(items).toHaveLength(1);
    expect(items[0].callId).toBe("call-a");
    expect(items[0].samples).toBe(3);
    expect(items[0].events).toBe(1);
  });

  it("上限ローテーション: MAX_STORED_CALLS+1件目の保存で最も古い(updatedAt)ものが消える", async () => {
    const { flushMeasurementLog, listMeasurementLogs, MAX_STORED_CALLS } = await freshModule();
    // updatedAt は nowMs 引数（明示的に古い順）を使って保存する。
    for (let i = 0; i < MAX_STORED_CALLS; i++) {
      await flushMeasurementLog(makeExport(`call-${i}`, { samples: 1 }), 1000 + i * 1000);
    }
    let items = await listMeasurementLogs();
    expect(items).toHaveLength(MAX_STORED_CALLS);

    // 11件目（最新）を保存 → 最古の call-0 が消えるはず。
    await flushMeasurementLog(
      makeExport(`call-${MAX_STORED_CALLS}`, { samples: 1 }),
      1000 + MAX_STORED_CALLS * 1000
    );
    items = await listMeasurementLogs();
    expect(items).toHaveLength(MAX_STORED_CALLS);
    const ids = items.map((i) => i.callId);
    expect(ids).not.toContain("call-0");
    expect(ids).toContain(`call-${MAX_STORED_CALLS}`);
    expect(ids).toContain("call-1"); // 2番目に古かったものは残る
  });

  it("フラッシュのマージ整合性: 同一call_idへの複数回フラッシュで最新化される（10秒フラッシュ→終了確定の順）", async () => {
    const { flushMeasurementLog, listMeasurementLogs, getMeasurementLog } = await freshModule();
    // 10秒間隔フラッシュ相当（samples少・途中経過）。
    await flushMeasurementLog(makeExport("call-x", { samples: 2, events: 0 }), 1000);
    // 通話終了時の確定フラッシュ相当（samplesが増え、eventsも追加された最終状態）。
    await flushMeasurementLog(makeExport("call-x", { samples: 5, events: 2 }), 2000);

    const items = await listMeasurementLogs();
    // call_id ごとに1レコードのみ（upsertで置き換わる。重複しない）。
    expect(items.filter((i) => i.callId === "call-x")).toHaveLength(1);
    const rec = await getMeasurementLog("call-x");
    expect(rec).not.toBeNull();
    expect(rec!.data.samples).toHaveLength(5);
    expect(rec!.data.events).toHaveLength(2);
    expect(rec!.updatedAt).toBe(new Date(2000).toISOString());
  });

  it("フラッシュのマージ整合性: 逆順（終了確定→遅れて10秒フラッシュ相当）で呼んでも矛盾なく最新のnowMs基準で上書きされる", async () => {
    const { flushMeasurementLog, getMeasurementLog } = await freshModule();
    // upsert は「呼ばれた時点の完全スナップショットで置き換える」方式のため、
    // 呼び出し順が入れ替わっても、最後に呼ばれたものが最終状態になる
    // （MeasurementLog 自体は単調増加のため、通常は後発呼び出しほど情報が多いか同等）。
    await flushMeasurementLog(makeExport("call-y", { samples: 5, events: 2 }), 5000);
    await flushMeasurementLog(makeExport("call-y", { samples: 5, events: 2 }), 6000);

    const rec = await getMeasurementLog("call-y");
    expect(rec).not.toBeNull();
    // 差分追記ではなく置き換えのため、2回目も samples=5/events=2 のまま重複・欠落しない。
    expect(rec!.data.samples).toHaveLength(5);
    expect(rec!.data.events).toHaveLength(2);
    expect(rec!.updatedAt).toBe(new Date(6000).toISOString());
  });

  it("listMeasurementLogs は updatedAt 降順（新しい順）で返す", async () => {
    const { flushMeasurementLog, listMeasurementLogs } = await freshModule();
    await flushMeasurementLog(makeExport("call-old", { samples: 1 }), 1000);
    await flushMeasurementLog(makeExport("call-mid", { samples: 1 }), 2000);
    await flushMeasurementLog(makeExport("call-new", { samples: 1 }), 3000);

    const items = await listMeasurementLogs();
    expect(items.map((i) => i.callId)).toEqual(["call-new", "call-mid", "call-old"]);
  });

  it("getMeasurementLog: 存在しない call_id は null を返す", async () => {
    const { getMeasurementLog } = await freshModule();
    const rec = await getMeasurementLog("does-not-exist");
    expect(rec).toBeNull();
  });

  it("deleteMeasurementLog: 指定call_idのレコードが削除され一覧から消える", async () => {
    const { flushMeasurementLog, listMeasurementLogs, deleteMeasurementLog, getMeasurementLog } =
      await freshModule();
    await flushMeasurementLog(makeExport("call-del-1", { samples: 1 }), 1000);
    await flushMeasurementLog(makeExport("call-del-2", { samples: 1 }), 2000);
    expect(await listMeasurementLogs()).toHaveLength(2);

    await deleteMeasurementLog("call-del-1");
    const items = await listMeasurementLogs();
    expect(items).toHaveLength(1);
    expect(items[0].callId).toBe("call-del-2");
    expect(await getMeasurementLog("call-del-1")).toBeNull();
  });
});
