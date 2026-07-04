// 委託コア②（検知キャプチャ）: Azure Speech による STT（感情ワード検知）プロバイダ
//
// 【STT・削減ラダー②解除】高齢者側リモート音声トラックを ja-JP で連続認識し、
// 感情ワード辞書（sttConfig.ts）でヒットを検出する。SttProvider インターフェース実装。
//
// 音声経路:
//   MediaStreamTrack → WebAudio(AudioContext) → ScriptProcessor で Float32 取得
//   → PCM16・16kHz にダウンサンプリング → SDK の PushAudioInputStream へ供給
//   → SpeechRecognizer（連続認識）
//
// トークン:
//   backend /tokens/speech から短命トークン（約10分）を取得し、約9分ごとに更新する。
//   AuthorizationToken を更新することで、認識を止めずに継続できる。
//
// フレーズリスト:
//   感情ワード辞書を PhraseListGrammar に登録し、これらの語の認識精度を上げる。
//
// 【best-effort】SDK ロード失敗・トークン取得失敗（Fake トークン時の認証失敗含む）では
//   警告ログのみで STT 無効のまま継続する（throw しない）。通話・RMS検知は影響を受けない。
//   → Playwright（Speech 未設定＝Fake トークン）で STT 無効経路が緑のままであることが重要。

import { issueSpeechToken } from "../../lib/api-client";
import {
  DEFAULT_STT_CONFIG,
  matchEmotionWords,
  type SttConfig,
} from "./sttConfig";
import type { SttProvider, SttResult } from "./sttProvider";

// microsoft-cognitiveservices-speech-sdk の型は動的 import 後に解決する。
// SSR / テスト環境で import 自体が失敗しても best-effort で無害化するため any 経由にする。
/* eslint-disable @typescript-eslint/no-explicit-any */
type SpeechSDK = any;

/** 直近の認識テキストを時刻つきで保持する（latest の時間窓判定に使う）。 */
interface RecognizedChunk {
  text: string;
  atMs: number;
}

/** 観測用の内部状態（window.__detection.state.stt に載せる）。 */
export interface SttRuntimeState {
  /** 認識が有効に立ち上がっているか（トークン取得＋SDK 接続に成功）。 */
  enabled: boolean;
  /** 直近（latestWindowMs 以内）の連結認識テキスト。 */
  lastText: string;
  /** 直近テキストから抽出した感情ワードヒット。 */
  labelHits: string[];
  /** 感情ワードヒットで安全網トリガーを発火させた回数。 */
  triggerCount: number;
}

export interface AzureSttOptions {
  /** STT 設定（辞書・言語・更新間隔など）。未指定なら支給初期値。 */
  config?: Partial<SttConfig>;
  /**
   * 感情ワードヒット時に呼ばれる安全網トリガー。index.ts が handleTrigger を渡す。
   * STT 起因の発火（reason="stt"）に使う。共有クールダウンは呼び出し側で適用する。
   */
  onEmotionHit?: (hits: string[], text: string) => void;
}

/**
 * Azure Speech による STT プロバイダ。
 * best-effort: 失敗しても throw せず、STT 無効のまま latest() は null を返す。
 */
export class AzureSttProvider implements SttProvider {
  private readonly cfg: SttConfig;
  private readonly onEmotionHit?: (hits: string[], text: string) => void;

  private sdk: SpeechSDK | null = null;
  private recognizer: any = null;
  private pushStream: any = null;

  // WebAudio（PCM 供給用）。
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private enabled = false;

  // 直近の認識結果（時間窓で latest() を作る）。
  private recognized: RecognizedChunk[] = [];
  private triggerCount = 0;

  constructor(opts: AzureSttOptions = {}) {
    this.cfg = { ...DEFAULT_STT_CONFIG, ...(opts.config ?? {}) };
    this.onEmotionHit = opts.onEmotionHit;
  }

  // --- SttProvider ----------------------------------------------------------

  async start(track: MediaStreamTrack): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.startInternal(track);
      this.enabled = true;
    } catch (e) {
      // best-effort: 失敗しても通話・RMS検知を止めない。
      this.enabled = false;
      // eslint-disable-next-line no-console
      console.warn("[stt] 起動に失敗（STT 無効のまま通話・RMS検知を継続）", e);
      // 起動途中で確保したリソースは解放しておく。
      await this.stop().catch(() => {});
      this.started = true; // stop() で false に戻るため再設定（多重 start を防ぐ）
    }
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    // 認識停止。
    if (this.recognizer) {
      try {
        await new Promise<void>((resolve) => {
          this.recognizer.stopContinuousRecognitionAsync(
            () => resolve(),
            () => resolve()
          );
        });
      } catch {
        /* noop */
      }
      try {
        this.recognizer.close();
      } catch {
        /* noop */
      }
      this.recognizer = null;
    }
    // WebAudio 解放。
    try {
      this.processor?.disconnect();
    } catch {
      /* noop */
    }
    try {
      this.sourceNode?.disconnect();
    } catch {
      /* noop */
    }
    if (this.audioCtx) {
      try {
        await this.audioCtx.close();
      } catch {
        /* noop */
      }
    }
    this.processor = null;
    this.sourceNode = null;
    this.audioCtx = null;
    try {
      this.pushStream?.close();
    } catch {
      /* noop */
    }
    this.pushStream = null;
    this.enabled = false;
    this.started = false;
  }

  latest(): SttResult | null {
    if (!this.enabled) return null;
    const text = this.recentText(Date.now());
    if (!text) return null;
    return { text, labels: matchEmotionWords(text, this.cfg.emotionWords) };
  }

  /** 観測用の状態スナップショット（index.ts が window フックに載せる）。 */
  state(): SttRuntimeState {
    const text = this.recentText(Date.now());
    return {
      enabled: this.enabled,
      lastText: text,
      labelHits: text ? matchEmotionWords(text, this.cfg.emotionWords) : [],
      triggerCount: this.triggerCount,
    };
  }

  // --- 内部 -----------------------------------------------------------------

  /** 直近 latestWindowMs 以内の認識テキストを連結して返す。 */
  private recentText(nowMs: number): string {
    const cutoff = nowMs - this.cfg.latestWindowMs;
    this.recognized = this.recognized.filter((c) => c.atMs >= cutoff);
    return this.recognized.map((c) => c.text).join(" ").trim();
  }

  /** 起動本体（失敗時は throw して start() 側で無害化する）。 */
  private async startInternal(track: MediaStreamTrack): Promise<void> {
    // 1) SDK を動的 import（SSR 回避・ロード失敗は best-effort で無害化）。
    this.sdk = await import("microsoft-cognitiveservices-speech-sdk");
    const SDK = this.sdk;

    // 2) 短命トークンを取得（Fake トークンだと後段の接続で認証失敗＝best-effort で無効化）。
    const tok = await issueSpeechToken();

    // 3) SpeechConfig（AuthorizationToken 方式・約9分ごとに更新）。
    const speechConfig = SDK.SpeechConfig.fromAuthorizationToken(
      tok.token,
      tok.region
    );
    speechConfig.speechRecognitionLanguage = this.cfg.language;

    // 4) PushAudioInputStream（16kHz / 16bit / mono）を用意し、WebAudio から供給する。
    const format = SDK.AudioStreamFormat.getWaveFormatPCM(
      this.cfg.targetSampleRate,
      16,
      1
    );
    this.pushStream = SDK.AudioInputStream.createPushStream(format);
    this.setupPcmPump(track);

    const audioConfig = SDK.AudioConfig.fromStreamInput(this.pushStream);
    this.recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig);

    // 5) フレーズリスト（感情ワード辞書）で認識を強化する。
    const phraseList = SDK.PhraseListGrammar.fromRecognizer(this.recognizer);
    for (const w of this.cfg.emotionWords) {
      phraseList.addPhrase(w);
    }

    // 6) 認識イベント。確定（recognized）テキストを蓄積し、感情ワードヒットで発火通知。
    this.recognizer.recognized = (_s: any, ev: any) => {
      const result = ev?.result;
      if (!result || result.reason !== SDK.ResultReason.RecognizedSpeech) return;
      const text: string = (result.text ?? "").trim();
      if (!text) return;
      this.recognized.push({ text, atMs: Date.now() });
      const hits = matchEmotionWords(text, this.cfg.emotionWords);
      if (hits.length > 0) {
        this.triggerCount += 1;
        this.onEmotionHit?.(hits, text);
      }
    };
    this.recognizer.canceled = (_s: any, ev: any) => {
      // 認証失敗（Fake トークン）等はここに来る。best-effort で無効化する。
      // eslint-disable-next-line no-console
      console.warn("[stt] 認識がキャンセルされました（STT 無効化）", ev?.errorDetails);
      this.enabled = false;
    };

    // 7) 連続認識を開始。
    await new Promise<void>((resolve, reject) => {
      this.recognizer.startContinuousRecognitionAsync(
        () => resolve(),
        (err: unknown) => reject(err)
      );
    });

    // 8) トークンを約9分ごとに更新（短命トークン=約10分の手前）。
    this.refreshTimer = setInterval(() => {
      void this.refreshToken();
    }, this.cfg.tokenRefreshMs);
  }

  /** トークンを再取得して recognizer に反映する（失敗は警告のみ）。 */
  private async refreshToken(): Promise<void> {
    try {
      const tok = await issueSpeechToken();
      if (this.recognizer) {
        this.recognizer.authorizationToken = tok.token;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[stt] トークン更新に失敗（次回更新で再試行）", e);
    }
  }

  /**
   * リモート音声トラックを WebAudio で受け、Float32 → PCM16・16kHz に
   * ダウンサンプリングして PushAudioInputStream へ書き込む。
   */
  private setupPcmPump(track: MediaStreamTrack): void {
    const AC: typeof AudioContext =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    this.audioCtx = new AC();
    const inRate = this.audioCtx.sampleRate; // 実機は 44.1k / 48k が多い
    const outRate = this.cfg.targetSampleRate; // 16k

    const mediaStream = new MediaStream([track]);
    this.sourceNode = this.audioCtx.createMediaStreamSource(mediaStream);

    // ScriptProcessorNode（非推奨だが Chrome で安定・SDK 供給に十分）。
    // バッファ 4096・mono 入出力。出力は使わないが接続が必要。
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (!this.pushStream) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = downsampleToPcm16(input, inRate, outRate);
      if (pcm16.byteLength > 0) {
        // PushAudioInputStream.write は ArrayBuffer を受ける。
        this.pushStream.write(pcm16.buffer);
      }
    };

    this.sourceNode.connect(this.processor);
    // 出力は鳴らさない（相手音声は Agora 側が既に再生している）。
    // ScriptProcessor は destination へ接続しないと発火しないブラウザがあるため、
    // ゲイン0 経由で destination に繋いで無音化する。
    const mute = this.audioCtx.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute);
    mute.connect(this.audioCtx.destination);
  }
}

/**
 * Float32 PCM（[-1,1]）を outRate へ線形補間ダウンサンプリングし、
 * 16bit little-endian PCM（Int16Array）に変換する（純粋関数・vitest 対象）。
 *
 * inRate <= outRate の場合は素通し（間引かない）でそのまま 16bit 化する。
 */
export function downsampleToPcm16(
  input: Float32Array,
  inRate: number,
  outRate: number
): Int16Array {
  if (input.length === 0) return new Int16Array(0);

  let samples: Float32Array;
  if (outRate >= inRate) {
    // アップサンプルはしない（そのまま 16bit 化）。
    samples = input;
  } else {
    const ratio = inRate / outRate;
    const outLen = Math.floor(input.length / ratio);
    samples = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      // 線形補間（隣接2サンプルの重み付き平均）。
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = input[idx] ?? 0;
      const s1 = input[idx + 1] ?? s0;
      samples[i] = s0 + (s1 - s0) * frac;
    }
  }

  const pcm16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // クランプして 16bit へ。
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm16;
}
