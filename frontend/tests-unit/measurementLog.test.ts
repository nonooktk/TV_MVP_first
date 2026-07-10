// MeasurementLog（計測ログ・読み取り専用オブザーバー）の単体テスト
//
// 検証観点（指示準拠）:
//   1. ピークホールド: 1秒間の rise / 重心比の最大値がサマリサンプルへ反映される（瞬間値ではない）
//   2. リング上限: samples は最大 3600 件、events は最大 200 件で古いものから溢れる
//   3. シリアライズ: toExport() が version/call_id/exported_at/params/samples/events を持つ
//   4. イベント記録: recordTriggerStart → recordTriggerComplete で photo_count・partial_save が埋まる

import { describe, expect, it } from "vitest";
import {
  MAX_EVENTS,
  MAX_SAMPLES,
  MeasurementLog,
  SAMPLE_INTERVAL_MS,
} from "../src/modules/detection/measurementLog";
import { DEFAULT_RMS_PARAMS, type RmsTriggerState } from "../src/modules/detection/rmsTrigger";
import {
  DEFAULT_CENTROID_PARAMS,
  type CentroidTriggerState,
} from "../src/modules/detection/centroidTrigger";

const PARAMS = { rms: DEFAULT_RMS_PARAMS, centroid: DEFAULT_CENTROID_PARAMS };

/** テスト用のダミー RmsTriggerState。 */
function rmsSnapshot(overrides: Partial<RmsTriggerState> = {}): RmsTriggerState {
  return {
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
    ...overrides,
  };
}

/** テスト用のダミー CentroidTriggerState。 */
function centroidSnapshot(overrides: Partial<CentroidTriggerState> = {}): CentroidTriggerState {
  return {
    lastCentroidHz: 1200,
    baselineHz: 1000,
    riseRatio: 1.2,
    sustainedMs: 0,
    armed: true,
    ...overrides,
  };
}

describe("MeasurementLog", () => {
  it("1秒間のピークホールド: 瞬間値でなくその区間の rise / 重心比の最大値をサンプルへ記録する", () => {
    const log = new MeasurementLog("call-1", PARAMS, 0);

    // 0.1s間隔で rise が 3 → 10 → 5 と変化する短いイベント（sustain 150ms 相当）を模す。
    log.observeFrame({ riseDb: 3, isSpeech: false, centroidRatio: null }, 100);
    log.observeFrame({ riseDb: 10, isSpeech: true, centroidRatio: 1.35 }, 200); // ピーク
    log.observeFrame({ riseDb: 5, isSpeech: false, centroidRatio: 1.1 }, 300);

    // tick は1秒経過後に呼ぶ（最初の tick は間引かれず確定する）。
    log.tick(
      {
        rms: rmsSnapshot({ lastRmsDb: -22 }),
        centroid: centroidSnapshot(),
        noiseFloorDb: -50,
        autoGainDb: 4,
      },
      1000
    );

    const exported = log.toExport(1000);
    expect(exported.samples).toHaveLength(1);
    const sample = exported.samples[0];
    // 瞬間値（最後の値=5・1.1）ではなく、区間内の最大値（10dB・1.35倍）が記録されること。
    expect(sample.rise_peak_db).toBe(10);
    expect(sample.centroid_ratio_peak).toBe(1.35);
    // 現在値フィールドは tick 時点のスナップショットをそのまま使う。
    expect(sample.rms_db).toBe(-22);
    expect(sample.noise_floor_db).toBe(-50);
    expect(sample.auto_gain_db).toBe(4);
    // 発話フレーム率: 3フレーム中1フレームが発話 → 1/3。
    expect(sample.speech_ratio).toBeCloseTo(1 / 3, 5);
  });

  it("tick は SAMPLE_INTERVAL_MS 未満の間隔では新しいサンプルを積まない（1Hzへ間引く）", () => {
    const log = new MeasurementLog("call-1", PARAMS, 0);
    log.tick(
      { rms: rmsSnapshot(), centroid: centroidSnapshot(), noiseFloorDb: null, autoGainDb: null },
      1000
    );
    log.tick(
      { rms: rmsSnapshot(), centroid: centroidSnapshot(), noiseFloorDb: null, autoGainDb: null },
      1000 + SAMPLE_INTERVAL_MS - 1
    );
    expect(log.toExport().samples).toHaveLength(1);

    log.tick(
      { rms: rmsSnapshot(), centroid: centroidSnapshot(), noiseFloorDb: null, autoGainDb: null },
      1000 + SAMPLE_INTERVAL_MS
    );
    expect(log.toExport().samples).toHaveLength(2);
  });

  it("リング上限: samples は最大 MAX_SAMPLES 件で古いものから溢れる", () => {
    const log = new MeasurementLog("call-1", PARAMS, 0);
    const total = MAX_SAMPLES + 10;
    for (let i = 0; i < total; i++) {
      log.tick(
        {
          rms: rmsSnapshot({ lastRmsDb: i }), // t 相当の値を仕込み、先頭が溢れたか判別する
          centroid: centroidSnapshot(),
          noiseFloorDb: null,
          autoGainDb: null,
        },
        i * SAMPLE_INTERVAL_MS
      );
    }
    const exported = log.toExport();
    expect(exported.samples).toHaveLength(MAX_SAMPLES);
    // 最初の10件が押し出され、先頭は i=10 のサンプルになっているはず。
    expect(exported.samples[0].rms_db).toBe(10);
    expect(exported.samples[exported.samples.length - 1].rms_db).toBe(total - 1);
  });

  it("リング上限: events は最大 MAX_EVENTS 件で古いものから溢れる", () => {
    const log = new MeasurementLog("call-1", PARAMS, 0);
    const total = MAX_EVENTS + 5;
    for (let i = 0; i < total; i++) {
      log.recordTriggerStart(
        "rms",
        rmsSnapshot({ lastRmsDb: i }),
        centroidSnapshot(),
        null,
        i * 1000
      );
      log.recordTriggerComplete(1, false);
    }
    const exported = log.toExport();
    expect(exported.events).toHaveLength(MAX_EVENTS);
    expect(exported.events[0].rms.lastRmsDb).toBe(5);
    expect(exported.events[exported.events.length - 1].rms.lastRmsDb).toBe(total - 1);
  });

  it("シリアライズ: toExport() が version/call_id/exported_at/params/samples/events を持つ", () => {
    const log = new MeasurementLog("call-xyz", PARAMS, 0);
    log.tick(
      { rms: rmsSnapshot(), centroid: centroidSnapshot(), noiseFloorDb: null, autoGainDb: null },
      1000
    );
    const exported = log.toExport(123456);
    expect(exported.version).toBe(1);
    expect(exported.call_id).toBe("call-xyz");
    expect(exported.exported_at).toBe(new Date(123456).toISOString());
    expect(exported.params.rms).toEqual(DEFAULT_RMS_PARAMS);
    expect(exported.params.centroid).toEqual(DEFAULT_CENTROID_PARAMS);
    expect(Array.isArray(exported.samples)).toBe(true);
    expect(Array.isArray(exported.events)).toBe(true);
    // JSON.stringify できること（Blob ダウンロードに使うため循環参照等が無いこと）。
    expect(() => JSON.stringify(exported)).not.toThrow();
  });

  it("イベント記録: recordTriggerStart → recordTriggerComplete で photo_count・partial_save が埋まる", () => {
    const log = new MeasurementLog("call-1", PARAMS, 0);
    const rms = rmsSnapshot({ riseDb: 30, mode: "speech", armed: false });
    const centroid = centroidSnapshot({ riseRatio: 1.4, armed: false });
    log.recordTriggerStart("centroid", rms, centroid, 6.5, 5000);

    let exported = log.toExport();
    expect(exported.events).toHaveLength(1);
    const ev = exported.events[0];
    expect(ev.type).toBe("trigger");
    expect(ev.reason).toBe("centroid");
    expect(ev.t).toBe(5); // elapsed sec = (5000-0)/1000
    expect(ev.rms).toEqual(rms);
    expect(ev.centroid).toEqual(centroid);
    expect(ev.auto_gain_db).toBe(6.5);
    // 完了前は未確定。
    expect(ev.photo_count).toBeNull();
    expect(ev.partial_save).toBe(false);

    log.recordTriggerComplete(8, true);
    exported = log.toExport();
    expect(exported.events[0].photo_count).toBe(8);
    expect(exported.events[0].partial_save).toBe(true);
  });

  it("recordTriggerComplete は直近の未完了イベントのみを更新する（複数発火の取り違えがない）", () => {
    const log = new MeasurementLog("call-1", PARAMS, 0);
    log.recordTriggerStart("rms", rmsSnapshot(), centroidSnapshot(), null, 1000);
    log.recordTriggerComplete(3, false);
    log.recordTriggerStart("stt", rmsSnapshot(), centroidSnapshot(), null, 2000);
    log.recordTriggerComplete(5, false);

    const exported = log.toExport();
    expect(exported.events).toHaveLength(2);
    expect(exported.events[0].reason).toBe("rms");
    expect(exported.events[0].photo_count).toBe(3);
    expect(exported.events[1].reason).toBe("stt");
    expect(exported.events[1].photo_count).toBe(5);
  });

  it("counts() が現在の samples/events 件数を返す（デバッグパネルの小表示用）", () => {
    const log = new MeasurementLog("call-1", PARAMS, 0);
    expect(log.counts()).toEqual({ samples: 0, events: 0 });
    log.tick(
      { rms: rmsSnapshot(), centroid: centroidSnapshot(), noiseFloorDb: null, autoGainDb: null },
      1000
    );
    log.recordTriggerStart("rms", rmsSnapshot(), centroidSnapshot(), null, 1000);
    expect(log.counts()).toEqual({ samples: 1, events: 1 });
  });

  it("clear() で samples・events が空になる（「ログクリア」ボタン用）", () => {
    const log = new MeasurementLog("call-1", PARAMS, 0);
    log.tick(
      { rms: rmsSnapshot(), centroid: centroidSnapshot(), noiseFloorDb: null, autoGainDb: null },
      1000
    );
    log.recordTriggerStart("rms", rmsSnapshot(), centroidSnapshot(), null, 1000);
    log.recordTriggerComplete(2, false);
    expect(log.counts()).toEqual({ samples: 1, events: 1 });

    log.clear();
    expect(log.counts()).toEqual({ samples: 0, events: 0 });
    expect(log.toExport().samples).toHaveLength(0);
    expect(log.toExport().events).toHaveLength(0);
  });
});
