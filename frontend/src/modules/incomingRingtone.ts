// 着信音（call音）のループ再生を制御する「開始/停止判定」の純粋ロジック（変更2）。
//
// 待受画面のフェーズは standby（待受）→ incoming（着信あり）→ in_call（通話中）と遷移する。
// 着信音は「着信あり（incoming）」の間だけループ再生し、それ以外では止める。停止条件は
// タスク要件どおり以下の3つだが、いずれも「incoming から抜けた」＝「phase !== incoming」で
// 一律に表現できる:
//   1. 「でる」で応答した        → phase が in_call に変わる
//   2. 着信が失効・消滅した       → ポーリングが incoming=false に戻り phase が standby に変わる
//   3. 通話画面へ遷移する         → phase が in_call に変わる
//
// audio 要素そのものは DOM 依存のため、ここでは「今の再生状態」と「今のフェーズ」から
// audio へ行うべき操作（start / stop / none）だけを純粋関数として決める。実際の play() /
// pause() は呼び出し側（React 効果）が担い、本モジュールは vitest で単体検証する。

// 待受画面のフェーズ。standbyAlbum と同様、この3値のみを扱う。
export type RingtonePhase = "standby" | "incoming" | "in_call";

/**
 * 着信音を鳴らすべきフェーズか。着信あり（incoming）のときだけ true。
 */
export function shouldRing(phase: RingtonePhase): boolean {
  return phase === "incoming";
}

/**
 * 現在の再生状態（playing）と現在のフェーズから、audio 要素へ行うべき操作を決める。
 *
 * - "start": 停止中で、鳴らすべきフェーズ（incoming）になった → play()（loop 前提）。
 * - "stop":  再生中で、鳴らすべきでないフェーズ（応答/失効/通話遷移）になった → pause + 先頭へ。
 * - "none":  望ましい状態と現状が一致（変化なし）→ 何もしない（再入で play() を重ねない）。
 *
 * @param playing 現在 audio が再生中か（呼び出し側が保持する再生状態）
 * @param phase   現在のフェーズ
 */
export function ringtoneAction(
  playing: boolean,
  phase: RingtonePhase,
): "start" | "stop" | "none" {
  const desired = shouldRing(phase);
  if (desired && !playing) return "start";
  if (!desired && playing) return "stop";
  return "none";
}
