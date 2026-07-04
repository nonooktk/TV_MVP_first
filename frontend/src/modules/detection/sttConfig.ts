// 委託コア②（検知キャプチャ）: STT（感情ワード検知）の設定オブジェクト
//
// 【STT・削減ラダー②解除】感情ワード辞書と STT の各種パラメータを 1 箇所に集約する。
// 辞書は docs/detection-params.md の「感情ワード辞書」節にも同じ初期値を記載する。
//
// ※ 辞書・しきい値は「支給初期値」であり、精度チューニングは検収対象外
//   （CLAUDE.md の開発ルール・docs/detection-params.md）。

/** 感情ワード辞書（初期値）。ja-JP のフレーズリストとマッチング両方に使う。 */
export const EMOTION_WORDS: readonly string[] = [
  "かわいい",
  "かわいいね",
  "大きくなった",
  "大きくなったね",
  "すごい",
  "すごいね",
  "おめでとう",
  "ありがとう",
  "会いたい",
  "元気だね",
  "上手",
  "笑った",
] as const;

/** STT の動作パラメータ（支給初期値。チューニングは検収対象外）。 */
export interface SttConfig {
  /** 認識言語（BCP-47）。高齢者側の発話を対象にする。 */
  language: string;
  /** 感情ワード辞書（フレーズリスト＋部分一致マッチングに使う）。 */
  emotionWords: readonly string[];
  /** latest() が「直近」とみなす時間窓（ms）。約10秒。 */
  latestWindowMs: number;
  /** トークン更新間隔（ms）。短命トークン（約10分）より前の約9分で更新する。 */
  tokenRefreshMs: number;
  /** 認識に供給する PCM のサンプリングレート（Hz）。SDK 既定は 16kHz。 */
  targetSampleRate: number;
}

export const DEFAULT_STT_CONFIG: SttConfig = {
  language: "ja-JP",
  emotionWords: EMOTION_WORDS,
  latestWindowMs: 10_000, // 直近約10秒
  tokenRefreshMs: 9 * 60_000, // 約9分ごとに更新（短命トークン=約10分の手前）
  targetSampleRate: 16_000, // 16kHz（SDK の PushAudioInputStream 既定に合わせる）
};

/**
 * RMS/STT 共有クールダウンの判定（純粋関数・vitest 対象）。
 *
 * 直近発火時刻 `lastTriggerAtMs` から `cooldownMs` 未満の `nowMs` では発火を抑止する。
 * 抑止対象は RMS/STT の実発火のみ（テストの forceTrigger は呼び出し側で除外する）。
 *
 * @returns true=発火してよい（クールダウン通過）/ false=抑止する
 */
export function passesSharedCooldown(
  nowMs: number,
  lastTriggerAtMs: number,
  cooldownMs: number
): boolean {
  return nowMs - lastTriggerAtMs >= cooldownMs;
}

/**
 * テキストから感情ワードのヒットを抽出する（純粋関数・vitest 対象）。
 *
 * - 部分一致（`text.includes(word)`）で判定する。
 * - 複数ワードがヒットしたら全て返す。重複は除く。
 * - 「かわいいね」は「かわいい」も含むため両方ヒットしうる（辞書どおりに全件返す）。
 *
 * @returns ヒットした感情ワードの配列（ヒットなしは空配列）。
 */
export function matchEmotionWords(
  text: string,
  words: readonly string[] = EMOTION_WORDS
): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const w of words) {
    if (text.includes(w) && !hits.includes(w)) {
      hits.push(w);
    }
  }
  return hits;
}
