// STT（感情ワード検知）の純粋ロジックの単体テスト（削減ラダー②解除）
//
// 検証観点:
//   1. 感情ワードのマッチング（部分一致・複数ヒット・重複除去・ヒットなし）
//   2. RMS/STT 共有クールダウンの判定ロジック
//   3. PCM16 ダウンサンプリングの基本性質（純粋部分）

import { describe, expect, it } from "vitest";
import {
  DEFAULT_STT_CONFIG,
  EMOTION_WORDS,
  matchEmotionWords,
  passesSharedCooldown,
} from "../src/modules/detection/sttConfig";
import { downsampleToPcm16 } from "../src/modules/detection/azureSttProvider";

describe("matchEmotionWords（感情ワードのマッチング）", () => {
  it("部分一致でヒットする（文中に含まれれば拾う）", () => {
    expect(matchEmotionWords("わあ、かわいいですね")).toEqual(["かわいい"]);
  });

  it("複数の感情ワードがヒットしたら全て返す", () => {
    const hits = matchEmotionWords("すごい、大きくなったね！");
    expect(hits).toContain("すごい");
    expect(hits).toContain("大きくなった");
    expect(hits).toContain("大きくなったね");
  });

  it("「かわいいね」は「かわいい」も含むため両方ヒットする（辞書どおり全件）", () => {
    const hits = matchEmotionWords("ほんとにかわいいね");
    expect(hits).toContain("かわいい");
    expect(hits).toContain("かわいいね");
  });

  it("ヒットなしは空配列を返す", () => {
    expect(matchEmotionWords("きょうは天気がいい")).toEqual([]);
  });

  it("空文字は空配列を返す", () => {
    expect(matchEmotionWords("")).toEqual([]);
  });

  it("既定辞書に初期値の感情ワードが含まれる", () => {
    for (const w of [
      "かわいい",
      "大きくなった",
      "すごい",
      "おめでとう",
      "ありがとう",
      "会いたい",
      "元気だね",
      "上手",
      "笑った",
    ]) {
      expect(EMOTION_WORDS).toContain(w);
    }
  });
});

describe("passesSharedCooldown（RMS/STT 共有クールダウン）", () => {
  const CD = DEFAULT_STT_CONFIG.tokenRefreshMs; // 使わない（明示値でテストする）

  it("クールダウン中（経過 < cooldown）は抑止する（false）", () => {
    // 直近発火から 4000ms 未満 → false
    expect(passesSharedCooldown(1000, 0, 4000)).toBe(false);
    expect(passesSharedCooldown(3999, 0, 4000)).toBe(false);
  });

  it("クールダウン経過ちょうど・超過は通過する（true）", () => {
    expect(passesSharedCooldown(4000, 0, 4000)).toBe(true);
    expect(passesSharedCooldown(5000, 0, 4000)).toBe(true);
  });

  it("初回（lastTriggerAtMs=0・十分経過）は通過する", () => {
    expect(passesSharedCooldown(10_000, 0, 4000)).toBe(true);
    void CD;
  });
});

describe("downsampleToPcm16（PCM16 ダウンサンプリング）", () => {
  it("空入力は空を返す", () => {
    expect(downsampleToPcm16(new Float32Array(0), 48000, 16000).length).toBe(0);
  });

  it("48kHz → 16kHz でおおよそ 1/3 の長さになる", () => {
    const input = new Float32Array(3000); // 3000 サンプル
    const out = downsampleToPcm16(input, 48000, 16000);
    // 3000 / (48000/16000)=1000 前後
    expect(out.length).toBe(1000);
  });

  it("[-1,1] の値が 16bit レンジにマッピングされる（クランプ含む）", () => {
    // outRate>=inRate は素通し（間引かない）経路で 16bit 化を確認する。
    const input = new Float32Array([0, 1, -1, 2, -2]);
    const out = downsampleToPcm16(input, 16000, 16000);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0x7fff); // +1.0 → 最大
    expect(out[2]).toBe(-0x8000); // -1.0 → 最小
    expect(out[3]).toBe(0x7fff); // +2.0 はクランプで最大
    expect(out[4]).toBe(-0x8000); // -2.0 はクランプで最小
  });
});
