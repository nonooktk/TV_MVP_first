// 委託コア②（検知キャプチャ）: STT（音声認識）プロバイダのインターフェース＋noopスタブ
//
// 【削減ラダー②適用】RFP 10章の削減優先順位で②=STTトリガー。Azure Speech アカウント
// 未取得のため、本MVPでは STT を実装しない（インターフェースと no-op スタブのみを置く）。
// Azure Speech 取得後にこのインターフェースを実装したプロバイダへ差し替える想定。
//
// 用途（本来）: 発火前後の認識テキスト（metadata.stt_text）と感情ワードヒット
// （metadata.stt_labels）の付与、および STT 由来の安全網トリガー（trigger_reason="stt"）。

/** STT の認識結果。 */
export interface SttResult {
  /** 認識テキスト（metadata.stt_text の素）。 */
  text: string;
  /** 感情ワードのヒット（metadata.stt_labels の素）。 */
  labels: string[];
}

/** STT プロバイダのインターフェース。 */
export interface SttProvider {
  /** 認識を開始する（音声トラックを購読する）。 */
  start(track: MediaStreamTrack): Promise<void>;
  /** 認識を停止する。 */
  stop(): Promise<void>;
  /**
   * 直近の認識結果を取得する（発火時に metadata へ付与するために呼ぶ）。
   * 実装が無い場合は null。
   */
  latest(): SttResult | null;
}

/**
 * no-op スタブ。何もせず、常に null を返す。
 * Azure Speech 未取得のためのプレースホルダ（削減ラダー②）。
 */
export class NoopSttProvider implements SttProvider {
  async start(_track: MediaStreamTrack): Promise<void> {
    // 何もしない（STT 未実装）。
  }
  async stop(): Promise<void> {
    // 何もしない。
  }
  latest(): SttResult | null {
    return null;
  }
}
