// 委託コア②（検知キャプチャ）: 音声パイプライン（RMS算出＋音声スニペット構成）
//
// 高齢者側リモート音声トラック（uid=2）を入力に:
//   1. WebAudio AnalyserNode で rms_dB を約50ms間隔で算出し、コールバックへ渡す
//      （RmsTrigger の入力になる）。
//   2. 並行して MediaRecorder（timeslice=1秒）でエンコード済みチャンクをリング保持する
//      （先頭チャンク=ヘッダは常時保持＋直近6秒ぶん）。
//   3. 発火時に「先頭チャンク＋発火前2秒〜後3秒ぶん」を結合して webm スニペットを構成する。
//
// 【割り切り（重要）】webm/opus のチャンクは MediaRecorder のタイムスライス境界で切られる。
// 先頭チャンク（0番目）にはコンテナヘッダ（EBML/クラスタ情報）が含まれるため、これを常に
// 保持し、区間チャンクの前に連結する。厳密には各チャンクは独立デコード可能ではないが、
// 「先頭チャンク＋連続区間チャンク」を素朴に Blob 結合すると Chrome では概ね再生可能な
// webm になる（MVP の割り切り。用途はラベリングと写真単体閲覧時の再生）。境界が完全一致
// しないため前後に多少の余白が乗りうるが、検収対象（発火前2秒〜後3秒を含む）は満たす。

/** 音声パイプラインの設定（支給初期値。チューニングは検収対象外）。 */
export interface AudioPipelineParams {
  /** RMS算出間隔（ms）。 */
  rmsIntervalMs: number;
  /** MediaRecorder のタイムスライス（ms）。 */
  timesliceMs: number;
  /** リング保持する区間（先頭チャンクを除く直近ぶん・ms）。 */
  ringMs: number;
  /** スニペットに含める発火前ぶん（ms）。 */
  preRollMs: number;
  /** スニペットに含める発火後ぶん（ms）。 */
  postRollMs: number;
}

export const DEFAULT_AUDIO_PARAMS: AudioPipelineParams = {
  rmsIntervalMs: 50,
  timesliceMs: 1000, // 1秒チャンク
  ringMs: 6000, // 直近6秒
  preRollMs: 2000, // 発火前2秒
  postRollMs: 3000, // 発火後3秒
};

/** リング内の1チャンク。 */
interface Chunk {
  blob: Blob;
  /** そのチャンクが確定した時刻（epoch ms）。 */
  atMs: number;
}

/** rms_dB を受け取るコールバック。 */
export type RmsListener = (rmsDb: number, nowMs: number) => void;

/**
 * 音声パイプライン本体。
 * start() で RMS 算出と MediaRecorder リング保持を開始。
 * buildSnippet() で「先頭チャンク＋発火前2秒〜後3秒」の webm を構成する（発火後3秒待つ）。
 */
export class AudioPipeline {
  private readonly track: MediaStreamTrack;
  private readonly p: AudioPipelineParams;
  private readonly onRms: RmsListener;

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rmsTimer: ReturnType<typeof setInterval> | null = null;

  private recorder: MediaRecorder | null = null;
  private mimeType = "audio/webm";
  private headerChunk: Chunk | null = null; // 先頭チャンク（ヘッダ）
  private ring: Chunk[] = []; // 直近区間チャンク

  constructor(
    track: MediaStreamTrack,
    onRms: RmsListener,
    params: Partial<AudioPipelineParams> = {}
  ) {
    this.track = track;
    this.onRms = onRms;
    this.p = { ...DEFAULT_AUDIO_PARAMS, ...params };
  }

  start(): void {
    this.startRms();
    this.startRecorder();
  }

  stop(): void {
    if (this.rmsTimer !== null) {
      clearInterval(this.rmsTimer);
      this.rmsTimer = null;
    }
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
    } catch {
      /* noop */
    }
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    try {
      if (this.recorder && this.recorder.state !== "inactive") {
        this.recorder.stop();
      }
    } catch {
      /* noop */
    }
    this.recorder = null;
  }

  // --- RMS（WebAudio AnalyserNode） -----------------------------------------
  private startRms(): void {
    try {
      const AudioCtor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.audioCtx = new AudioCtor();
      const stream = new MediaStream([this.track]);
      this.source = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.source.connect(this.analyser);

      const buf = new Float32Array(this.analyser.fftSize);
      this.rmsTimer = setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
        const rms = Math.sqrt(sumSq / buf.length);
        // dBFS 換算（無音は -Infinity になるので下限クランプ）。
        const db = rms > 1e-7 ? 20 * Math.log10(rms) : -100;
        this.onRms(db, Date.now());
      }, this.p.rmsIntervalMs);
    } catch (e) {
      // WebAudio 不可でも検知全体は止めない（RMS が来ないだけ）。
      // eslint-disable-next-line no-console
      console.warn("[detection] WebAudio RMS の初期化に失敗", e);
    }
  }

  // --- MediaRecorder リング -------------------------------------------------
  private startRecorder(): void {
    try {
      // 対応 mimeType を選ぶ（Chrome は audio/webm;codecs=opus）。
      const candidates = ["audio/webm;codecs=opus", "audio/webm"];
      this.mimeType =
        candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "audio/webm";
      const stream = new MediaStream([this.track]);
      this.recorder = new MediaRecorder(stream, { mimeType: this.mimeType });

      this.recorder.ondataavailable = (ev: BlobEvent) => {
        if (!ev.data || ev.data.size === 0) return;
        const chunk: Chunk = { blob: ev.data, atMs: Date.now() };
        if (this.headerChunk === null) {
          // 先頭チャンク=ヘッダは常時保持する。
          this.headerChunk = chunk;
          return;
        }
        this.ring.push(chunk);
        // 直近 ringMs ぶんだけ保持（先頭チャンクは別枠で常時保持）。
        const cutoff = Date.now() - this.p.ringMs;
        while (this.ring.length > 0 && this.ring[0].atMs < cutoff) {
          this.ring.shift();
        }
      };

      this.recorder.start(this.p.timesliceMs);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[detection] MediaRecorder の初期化に失敗", e);
    }
  }

  /**
   * 発火時刻を起点に「先頭チャンク＋発火前 preRoll〜後 postRoll」を結合した webm を返す。
   * 発火後 postRollMs ぶんのチャンクが確定するまで待ってから結合する。
   * MediaRecorder が使えない場合は null。
   */
  async buildSnippet(triggerAtMs: number): Promise<{ blob: Blob; mimeType: string } | null> {
    if (!this.recorder) return null;

    // 発火後ぶんのチャンクが揃うまで待つ（timeslice 境界を跨ぐため少し余分に待つ）。
    await new Promise((r) => setTimeout(r, this.p.postRollMs + this.p.timesliceMs));

    const from = triggerAtMs - this.p.preRollMs;
    const to = triggerAtMs + this.p.postRollMs;
    // 区間に重なるチャンク（チャンクは atMs 時点で「直前 timeslice ぶん」を含む）。
    const inRange = this.ring.filter(
      (c) => c.atMs >= from && c.atMs - this.p.timesliceMs <= to
    );

    const parts: Blob[] = [];
    if (this.headerChunk) parts.push(this.headerChunk.blob);
    for (const c of inRange) parts.push(c.blob);

    if (parts.length === 0) return null;
    // 割り切り: 先頭チャンク＋区間チャンクを素朴に結合（コメント冒頭の注記参照）。
    const blob = new Blob(parts, { type: this.mimeType });
    return { blob, mimeType: this.mimeType };
  }

  /** 観測用の状態。 */
  status(): { hasHeader: boolean; ringChunks: number; mimeType: string } {
    return {
      hasHeader: this.headerChunk !== null,
      ringChunks: this.ring.length,
      mimeType: this.mimeType,
    };
  }
}
