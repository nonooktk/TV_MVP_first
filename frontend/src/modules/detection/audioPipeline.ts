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

import { spectralCentroidHz } from "./centroidTrigger";

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
  /**
   * buildSnippet の内部タイムアウト（発火からの最大待機・ms）。
   * チャンクが揃わなくてもこの時間で必ず抜け、手元分で組み立て（無ければ null）。
   * 「待ち続ける」実装の除去（修正1）に用いる。
   */
  maxWaitMs: number;

  // --- 家族側 VAD 床の自動化（item 12） -------------------------------------
  /**
   * ノイズフロア推定を反映して VAD 床を更新する間隔（ms）。
   * 頻繁に動かすと発火判定が不安定になるため、ゆっくり（既定1秒ごと）反映する。
   */
  vadFloorUpdateMs: number;
  /**
   * ノイズフロア推定の下降 τ（ms）。より静かなサンプルには速く追従する
   * （＝ノイズフロアは「無音寄り＝低い側」を素早く拾う）。
   */
  noiseFloorFallTauMs: number;
  /**
   * ノイズフロア推定の上昇 τ（ms）。うるさい側へはゆっくり追従する
   * （＝発話の大音圧でノイズフロア推定が持ち上がらないよう遅くする）。
   */
  noiseFloorRiseTauMs: number;
  /** VAD 床 = ノイズフロア + このマージン（dB）。 */
  vadFloorMarginDb: number;
  /** VAD 床のクランプ下限（dB）。 */
  vadFloorMinDb: number;
  /** VAD 床のクランプ上限（dB）。 */
  vadFloorMaxDb: number;
}

export const DEFAULT_AUDIO_PARAMS: AudioPipelineParams = {
  rmsIntervalMs: 50,
  timesliceMs: 1000, // 1秒チャンク
  ringMs: 6000, // 直近6秒
  preRollMs: 2000, // 発火前2秒
  postRollMs: 3000, // 発火後3秒
  // 発火から6秒。postRoll(3s)+timeslice(1s)=4s を通常の到達目標とし、遅延やチャンク
  // 未到達でも6秒で必ず打ち切る（handleTrigger の8s全体タイムアウトより短く設定）。
  maxWaitMs: 6000,
  // 家族側 VAD 床の自動化（item 12）: ノイズ+8dB・[-70,-45] クランプを1秒ごとに反映。
  vadFloorUpdateMs: 1000,
  noiseFloorFallTauMs: 1000, // 静かな側へは速く（1s）追従
  noiseFloorRiseTauMs: 8000, // うるさい側へは遅く（8s）追従＝発話で持ち上がらない
  vadFloorMarginDb: 8,
  vadFloorMinDb: -70,
  vadFloorMaxDb: -45,
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
 * スペクトル重心(Hz)を受け取るコールバック（改良2）。
 * RMS と同じ 50ms 間隔で、AnalyserNode の周波数データから算出した重心を渡す。
 * 発話/非発話の判定は上位（rmsTrigger の発話ゲート）で行うため、ここでは毎サンプル渡す。
 */
export type CentroidListener = (centroidHz: number, nowMs: number) => void;

/**
 * 音声パイプライン本体。
 * start() で RMS 算出と MediaRecorder リング保持を開始。
 * buildSnippet() で「先頭チャンク＋発火前2秒〜後3秒」の webm を構成する（発火後3秒待つ）。
 */
/** VAD 床の自動更新を受け取るコールバック（推定した床 dB を渡す）。 */
export type VadFloorListener = (vadFloorDb: number) => void;

/** ノイズフロア推定を受け取るコールバック（発話ゲート用・改良1）。 */
export type NoiseFloorListener = (noiseFloorDb: number) => void;

export class AudioPipeline {
  private readonly track: MediaStreamTrack;
  private readonly p: AudioPipelineParams;
  private readonly onRms: RmsListener;
  private readonly onVadFloor: VadFloorListener | null;
  private readonly onCentroid: CentroidListener | null;
  private readonly onNoiseFloor: NoiseFloorListener | null;

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rmsTimer: ReturnType<typeof setInterval> | null = null;

  private recorder: MediaRecorder | null = null;
  private mimeType = "audio/webm";
  private headerChunk: Chunk | null = null; // 先頭チャンク（ヘッダ）
  private ring: Chunk[] = []; // 直近区間チャンク

  // 家族側 VAD 床の自動化（item 12）用の内部状態。
  private noiseFloorDb: number | null = null; // ノイズフロア推定（非対称EMA）
  private lastVadFloorAtMs = 0; // 最後に VAD 床を反映した時刻
  private lastRmsSampleMs: number | null = null; // ノイズフロア EMA の dt 用

  constructor(
    track: MediaStreamTrack,
    onRms: RmsListener,
    params: Partial<AudioPipelineParams> = {},
    onVadFloor: VadFloorListener | null = null,
    onCentroid: CentroidListener | null = null,
    onNoiseFloor: NoiseFloorListener | null = null
  ) {
    this.track = track;
    this.onRms = onRms;
    this.p = { ...DEFAULT_AUDIO_PARAMS, ...params };
    this.onVadFloor = onVadFloor;
    this.onCentroid = onCentroid;
    this.onNoiseFloor = onNoiseFloor;
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
      // スペクトル重心用の周波数データバッファ（dB 配列・長さ = fftSize/2）。
      const freqBuf = new Float32Array(this.analyser.frequencyBinCount);
      const sampleRate = this.audioCtx.sampleRate;
      this.rmsTimer = setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
        const rms = Math.sqrt(sumSq / buf.length);
        // dBFS 換算（無音は -Infinity になるので下限クランプ）。
        const db = rms > 1e-7 ? 20 * Math.log10(rms) : -100;
        const now = Date.now();
        this.onRms(db, now);
        // 家族側 VAD 床の自動化（item 12）: ノイズフロア推定 → 床を定期反映。
        const floor = this.updateNoiseFloor(db, now);
        if (floor !== null) this.onVadFloor?.(floor);
        // 発話ゲート用のノイズフロア推定（改良1）を毎サンプル反映する。
        if (this.noiseFloorDb !== null) this.onNoiseFloor?.(this.noiseFloorDb);
        // スペクトル重心（改良2）を算出して渡す（発話/非発話の判定は上位に委ねる）。
        if (this.onCentroid) {
          this.analyser.getFloatFrequencyData(freqBuf);
          const centroid = spectralCentroidHz(freqBuf, sampleRate);
          this.onCentroid(centroid, now);
        }
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
   *
   * 【重要・修正1（発火 busy 永久化の根絶）】
   * 以前はここで「発火後 postRoll+timeslice ぶんを固定 setTimeout で待つ」だけだったが、
   * MediaRecorder がチャンクを出さない環境（ondataavailable が発火しない・音声トラック
   * 停止など）では、この await が **postRoll 待ちのあと空 ring を返す**ものの、上位の
   * handleTrigger がここを含むキャプチャ全体で settle しない await（別要因）で詰まると
   * busy が解除されず 1 回発火後に永久停止する症状につながっていた。
   *
   * そこで本メソッド自体に **内部タイムアウト（発火から maxWaitMs=6s）** を持たせ、
   * 「発火後ぶんのチャンクが揃う」か「6s 到達」のどちらか早い方で必ず抜けるようにする。
   * チャンクが 1 つも溜まらなければ手元分（先頭チャンク＋区間チャンク）で組み立て、
   * 手元に何も無ければ null を返す。＝「待ち続ける」実装を除去する。
   *
   * MediaRecorder が使えない場合は null。
   */
  async buildSnippet(triggerAtMs: number): Promise<{ blob: Blob; mimeType: string } | null> {
    if (!this.recorder) return null;

    // 発火後ぶんのチャンクが「揃った」とみなす目標時刻（epoch ms）。
    const targetReadyAtMs = triggerAtMs + this.p.postRollMs + this.p.timesliceMs;
    // 発火から最大 maxWaitMs（内部タイムアウト）を超えて待たない。
    const deadlineMs = triggerAtMs + this.p.maxWaitMs;

    // ポーリングで「post-roll ぶんのチャンクが確定した」または「内部タイムアウト到達」まで待つ。
    // 固定 setTimeout ではなく短い間隔で条件を見ることで、チャンクが来ない環境でも
    // deadline で確実に抜ける（＝ハングしない）。
    await this.waitUntil(() => {
      const now = Date.now();
      if (now >= deadlineMs) return true; // 内部タイムアウト（手元分で組み立てる/null）
      if (now < targetReadyAtMs) return false; // まだ post-roll ぶんが経過していない
      // 目標時刻を過ぎた: 区間の末尾に達するチャンクが確定していれば揃ったとみなす。
      const to = triggerAtMs + this.p.postRollMs;
      return this.ring.some((c) => c.atMs >= to);
    }, deadlineMs);

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

  /**
   * cond() が true になるか deadlineMs へ到達するまで pollMs 間隔で待つ内部ヘルパ。
   * 「チャンクが来続けなくても必ず deadline で抜ける」ことを保証する（ハング防止）。
   */
  private waitUntil(cond: () => boolean, deadlineMs: number): Promise<void> {
    const pollMs = 100;
    return new Promise<void>((resolve) => {
      const tick = (): void => {
        if (cond() || Date.now() >= deadlineMs) {
          resolve();
          return;
        }
        setTimeout(tick, pollMs);
      };
      tick();
    });
  }

  /**
   * ノイズフロア推定を1サンプル進め、VAD 床の反映タイミングなら床（dB）を返す（item 12）。
   *
   * - ノイズフロア推定 `noiseFloorDb` は **非対称 EMA**（無音寄りの遅い追跡）:
   *   ・現サンプルが推定より低い（静か）→ 速い τ（noiseFloorFallTauMs）で下げる。
   *   ・現サンプルが推定より高い（うるさい／発話）→ 遅い τ（noiseFloorRiseTauMs）で上げる。
   *   これにより「発話でノイズフロアが持ち上がらず、静かな地の音量へじわっと張り付く」。
   * - vadFloorUpdateMs ごとに **床＝ノイズ+margin・[min,max] クランプ** を返す。
   *   それ以外のサンプルでは推定だけ進めて null を返す（毎サンプルは床を動かさない）。
   *
   * 純粋な状態遷移（DOM 非依存）なので単体テストできる。
   */
  updateNoiseFloor(db: number, nowMs: number): number | null {
    const dt =
      this.lastRmsSampleMs === null
        ? this.p.rmsIntervalMs
        : Math.max(0, nowMs - this.lastRmsSampleMs);
    this.lastRmsSampleMs = nowMs;

    if (this.noiseFloorDb === null) {
      this.noiseFloorDb = db; // 初回サンプルで確定
    } else {
      // 下げる（静かな側）は速く、上げる（うるさい側）は遅く追従する非対称 EMA。
      const tau =
        db < this.noiseFloorDb
          ? this.p.noiseFloorFallTauMs
          : this.p.noiseFloorRiseTauMs;
      const alpha = Math.min(1, dt / tau);
      this.noiseFloorDb = this.noiseFloorDb + alpha * (db - this.noiseFloorDb);
    }

    // 反映間隔に達していなければ床は動かさない（推定だけ進める）。
    if (nowMs - this.lastVadFloorAtMs < this.p.vadFloorUpdateMs) {
      // 初回は基準時刻を置くだけ（過去 0 との比較で即発火しないように）。
      if (this.lastVadFloorAtMs === 0) this.lastVadFloorAtMs = nowMs;
      return null;
    }
    this.lastVadFloorAtMs = nowMs;

    const raw = this.noiseFloorDb + this.p.vadFloorMarginDb;
    const clamped = Math.max(
      this.p.vadFloorMinDb,
      Math.min(this.p.vadFloorMaxDb, raw)
    );
    return clamped;
  }

  /** 現在のノイズフロア推定（デバッグ・テスト用）。 */
  noiseFloorEstimate(): number | null {
    return this.noiseFloorDb;
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
