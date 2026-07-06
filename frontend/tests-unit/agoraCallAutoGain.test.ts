// agoraCall の自動ゲイン適用（両側）の単体テスト（2026-07-07・家族側適用拡大）
//
// 検証観点:
//   1. 高齢者側（uid=2）: WebAudio チェーンが構築され、カスタムトラックが publish される。
//      観測値は window.__autoGain（既存キー・後方互換）へ書き込まれる。
//   2. 家族側（uid=1）: 同じくチェーンが構築され、カスタムトラックが publish される。
//      観測値は window.__autoGainFamily へ書き込まれる。
//   3. マイクの AGC:false は両 uid で統一される（自前正規化との二重調整を避ける）。
//   4. WebAudio 構築失敗時は生マイクを publish するフォールバック（従来どおり）。
//
// Agora SDK・WebAudio・MediaStream はモック（実ブラウザ経路は Playwright 側で検証）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Agora SDK モック --------------------------------------------------------
// dynamic import("agora-rtc-sdk-ng") を vi.mock で差し替える。__mock でテストから
// 各スパイへアクセスする。
vi.mock("agora-rtc-sdk-ng", () => {
  const client = {
    on: vi.fn(),
    subscribe: vi.fn(async () => {}),
    join: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    removeAllListeners: vi.fn(),
  };
  const micTrack = {
    kind: "mic",
    getMediaStreamTrack: vi.fn(() => ({ kind: "audio", id: "raw-mic" })),
    close: vi.fn(),
  };
  const camTrack = { kind: "cam", play: vi.fn(), close: vi.fn() };
  const customTrack = { kind: "custom", close: vi.fn() };
  const AgoraRTC = {
    setLogLevel: vi.fn(),
    createClient: vi.fn(() => client),
    createMicrophoneAndCameraTracks: vi.fn(async () => [micTrack, camTrack]),
    createCustomAudioTrack: vi.fn(() => customTrack),
  };
  return {
    default: AgoraRTC,
    __mock: { AgoraRTC, client, micTrack, camTrack, customTrack },
  };
});

// --- WebAudio / MediaStream モック -------------------------------------------
class FakeAudioNode {
  connect(): void {}
  disconnect(): void {}
}

class FakeMediaStream {
  tracks: Array<{ kind: string }>;
  constructor(tracks: Array<{ kind: string }> = []) {
    this.tracks = tracks;
  }
  getAudioTracks(): Array<{ kind: string }> {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}

class FakeAudioContext {
  currentTime = 0;
  createMediaStreamSource(): FakeAudioNode {
    return new FakeAudioNode();
  }
  createAnalyser(): FakeAudioNode & {
    fftSize: number;
    getFloatTimeDomainData: (buf: Float32Array) => void;
  } {
    return Object.assign(new FakeAudioNode(), {
      fftSize: 1024,
      getFloatTimeDomainData: (_buf: Float32Array) => {},
    });
  }
  createGain(): FakeAudioNode & {
    gain: { value: number; setTargetAtTime: (...a: unknown[]) => void };
  } {
    return Object.assign(new FakeAudioNode(), {
      gain: { value: 1, setTargetAtTime: (..._a: unknown[]) => {} },
    });
  }
  createMediaStreamDestination(): { stream: FakeMediaStream } {
    return { stream: new FakeMediaStream([{ kind: "audio" }]) };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

// モックの参照を取り出すヘルパ（vi.mock の戻りに __mock を同梱している）。
async function getAgoraMock() {
  const mod = (await import("agora-rtc-sdk-ng")) as unknown as {
    __mock: {
      AgoraRTC: {
        createMicrophoneAndCameraTracks: ReturnType<typeof vi.fn>;
        createCustomAudioTrack: ReturnType<typeof vi.fn>;
      };
      client: { publish: ReturnType<typeof vi.fn> };
      micTrack: unknown;
      camTrack: unknown;
      customTrack: unknown;
    };
  };
  return mod.__mock;
}

// node 環境の globalThis へ window / WebAudio / MediaStream を出し入れするため、
// 索引シグネチャ経由で扱う（lib.dom の非オプショナル宣言と衝突させない）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as unknown as Record<string, any>;

describe("agoraCall の自動ゲイン（両側適用）", () => {
  beforeEach(() => {
    // node 環境に window / WebAudio / MediaStream を用意する。
    g.window = g;
    g.AudioContext = FakeAudioContext;
    g.MediaStream = FakeMediaStream;
    delete g.__autoGain;
    delete g.__autoGainFamily;
    delete g.__callState;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete g.window;
    delete g.AudioContext;
    delete g.MediaStream;
  });

  async function start(uid: number) {
    const { startCall } = await import("../src/modules/call/agoraCall");
    return startCall({
      appId: "app",
      channel: "ch",
      token: "tok",
      uid,
      remoteContainer: {} as HTMLElement,
    });
  }

  it("高齢者側（uid=2）: チェーン構築＋カスタムトラック publish＋window.__autoGain", async () => {
    const m = await getAgoraMock();
    const handle = await start(2);
    // カスタムオーディオトラックが作られ、生マイクではなくそれが publish される。
    expect(m.AgoraRTC.createCustomAudioTrack).toHaveBeenCalledTimes(1);
    expect(m.client.publish).toHaveBeenCalledWith([m.customTrack, m.camTrack]);
    // 観測値は既存キー window.__autoGain（後方互換）。
    expect((g.__autoGain as { enabled: boolean }).enabled).toBe(true);
    expect(g.__autoGainFamily).toBeUndefined();
    await handle.leave();
  });

  it("家族側（uid=1）: チェーン構築＋カスタムトラック publish＋window.__autoGainFamily", async () => {
    const m = await getAgoraMock();
    const handle = await start(1);
    expect(m.AgoraRTC.createCustomAudioTrack).toHaveBeenCalledTimes(1);
    expect(m.client.publish).toHaveBeenCalledWith([m.customTrack, m.camTrack]);
    // 観測値は家族側キー window.__autoGainFamily（elder 側キーは汚さない）。
    expect((g.__autoGainFamily as { enabled: boolean }).enabled).toBe(true);
    expect(g.__autoGain).toBeUndefined();
    await handle.leave();
  });

  it("マイクの AGC:false は両 uid で統一される", async () => {
    const m = await getAgoraMock();
    const h1 = await start(1);
    await h1.leave();
    const h2 = await start(2);
    await h2.leave();
    expect(m.AgoraRTC.createMicrophoneAndCameraTracks).toHaveBeenCalledTimes(2);
    for (const call of m.AgoraRTC.createMicrophoneAndCameraTracks.mock.calls) {
      expect(call[0]).toEqual({ AGC: false });
    }
  });

  it("WebAudio 構築失敗時は生マイクを publish（フォールバック・従来どおり）", async () => {
    // AudioContext のコンストラクタで throw させる（webkitAudioContext も無し）。
    g.AudioContext = class {
      constructor() {
        throw new Error("no webaudio");
      }
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = await getAgoraMock();
    const handle = await start(1);
    expect(m.AgoraRTC.createCustomAudioTrack).not.toHaveBeenCalled();
    expect(m.client.publish).toHaveBeenCalledWith([m.micTrack, m.camTrack]);
    await handle.leave();
    warn.mockRestore();
  });
});
