// 着信音のループ再生の「開始/停止判定」純粋ロジック（shouldRing / ringtoneAction）の単体テスト（変更2）。
//
// - shouldRing: incoming のときだけ true。
// - ringtoneAction: 現在の再生状態とフェーズから start / stop / none を決める。
//   停止条件（応答→in_call・失効→standby・通話遷移→in_call）はいずれも
//   「phase !== incoming で再生中なら stop」に集約される。

import { describe, expect, it } from "vitest";

import {
  ringtoneAction,
  shouldRing,
  type RingtonePhase,
} from "../src/modules/incomingRingtone";

describe("shouldRing", () => {
  it("incoming のときだけ true を返す", () => {
    expect(shouldRing("incoming")).toBe(true);
    expect(shouldRing("standby")).toBe(false);
    expect(shouldRing("in_call")).toBe(false);
  });
});

describe("ringtoneAction", () => {
  it("停止中に incoming へ入ったら start（着信音を鳴らし始める）", () => {
    expect(ringtoneAction(false, "incoming")).toBe("start");
  });

  it("既に再生中で incoming のままなら none（play() を重ねない＝再入防止）", () => {
    expect(ringtoneAction(true, "incoming")).toBe("none");
  });

  it("再生中に in_call へ抜けたら stop（「でる」で応答・通話画面へ遷移）", () => {
    expect(ringtoneAction(true, "in_call")).toBe("stop");
  });

  it("再生中に standby へ戻ったら stop（着信が失効・消滅＝incoming=false）", () => {
    expect(ringtoneAction(true, "standby")).toBe("stop");
  });

  it("停止中に standby / in_call なら none（そもそも鳴らさない）", () => {
    expect(ringtoneAction(false, "standby")).toBe("none");
    expect(ringtoneAction(false, "in_call")).toBe("none");
  });

  it("待受→着信→応答→待受の一連の遷移で start→（維持）→stop→（無音）になる", () => {
    // 再生状態を呼び出し側の ref に見立てて追跡する。
    let playing = false;
    const step = (phase: RingtonePhase): "start" | "stop" | "none" => {
      const action = ringtoneAction(playing, phase);
      if (action === "start") playing = true;
      if (action === "stop") playing = false;
      return action;
    };

    expect(step("standby")).toBe("none"); // 待受: 無音
    expect(step("incoming")).toBe("start"); // 着信: 鳴らし始める
    expect(step("incoming")).toBe("none"); // 着信継続（3秒ポーリングの再評価）: 重ねない
    expect(step("in_call")).toBe("stop"); // 「でる」で応答: 止める
    expect(step("standby")).toBe("none"); // 通話終了で待受復帰: すでに無音
    expect(playing).toBe(false);
  });

  it("着信が応答されず失効した遷移（incoming→standby）でも stop になる", () => {
    let playing = false;
    const step = (phase: RingtonePhase): "start" | "stop" | "none" => {
      const action = ringtoneAction(playing, phase);
      if (action === "start") playing = true;
      if (action === "stop") playing = false;
      return action;
    };

    expect(step("incoming")).toBe("start"); // 着信: 鳴らす
    expect(step("standby")).toBe("stop"); // 120秒失効でポーリングが incoming=false: 止める
    expect(playing).toBe(false);
  });
});
