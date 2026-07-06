"use client";

// WF-01: 待受・着信「でる」・通話・動画再生画面（内製、通話部分は委託コア①=M1で実装済み）
//
// - 待受: 大きな時計・日付・「つながっています」表示。3秒ごとに GET /calls/incoming をポーリング
//   （backend 側は作成から120秒を超えた calling を着信として返さない=失効仕様）
// - 着信: 全画面で「{family_name} から でんわが きています」＋巨大な緑「でる」ボタン
//   （ことわるボタンは置かない仕様）
// - 通話（WF-01③）: 「でる」→ POST answer が返す app_id/token/channel_name/uid(=2) で
//   modules/call/agoraCall.ts が Agora チャンネルへ入室し、自分の映像/音声も publish する。
//   相手映像を全画面に表示し、「きる」は控えめに配置。
//   「きる」→ leave ＋ POST /calls/{id}/end → 待受復帰。
//   相手（家族側）が切った場合も自動で待受へ戻る（WF-01④）。
// - 「さいきんの おもいで を みる」: GET /albums/latest を全画面 video で再生

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Album,
  AnswerResponse,
  ApiError,
  answerCall,
  endCall,
  getDeviceToken,
  getLatestAlbum,
  pollIncomingCall,
} from "../../../lib/api-client";
import {
  CallHandle,
  startCall,
  type AutoGainDebugState,
  type CallState,
} from "../../../modules/call/agoraCall";

const POLL_INTERVAL_MS = 3000;

type Phase = "standby" | "incoming" | "in_call";

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export default function ElderStandbyPage() {
  const now = useClock();
  const [phase, setPhase] = useState<Phase>("standby");
  const [familyName, setFamilyName] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [answerData, setAnswerData] = useState<AnswerResponse | null>(null);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [hasDeviceToken, setHasDeviceToken] = useState<boolean | null>(null);
  const [callNotice, setCallNotice] = useState<string | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const remoteRef = useRef<HTMLDivElement | null>(null);
  const localRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CallHandle | null>(null);
  // handleHangup / onRemoteLeft から現在の callId を参照するための ref
  const callIdRef = useRef<string | null>(null);
  callIdRef.current = callId;

  useEffect(() => {
    setHasDeviceToken(!!getDeviceToken());
  }, []);

  // デバッグパネル: 通話中の「デバッグ」ボタンで開閉する。?debug=1 で初期表示ON（後方互換）。
  // 高齢者側の standby は静的エクスポートページなので location.search を直接見る。
  const [panelOpen, setPanelOpen] = useState(false);
  const [autoGain, setAutoGain] = useState<AutoGainDebugState | null>(null);
  // 接続状態（joined / remoteVideo）。agoraCall の観測フック window.__callState から取得。
  const [connState, setConnState] = useState<CallState | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("debug") === "1") {
      setPanelOpen(true);
    }
  }, []);
  useEffect(() => {
    if (!panelOpen || phase !== "in_call") return;
    const t = setInterval(() => {
      if (typeof window === "undefined") return;
      setAutoGain(window.__autoGain ?? null);
      setConnState(window.__callState ?? null);
    }, 200);
    return () => clearInterval(t);
  }, [panelOpen, phase]);

  const poll = useCallback(async () => {
    try {
      const status = await pollIncomingCall();
      if (status.incoming && status.call_id) {
        setCallId((prev) => (prev === status.call_id ? prev : status.call_id));
        setFamilyName(status.family_name ?? "かぞく");
        setPhase((prev) => (prev === "in_call" ? prev : "incoming"));
      } else {
        setPhase((prev) => (prev === "in_call" ? prev : "standby"));
      }
    } catch {
      // ポーリング失敗時は静かに次回リトライ（高齢者側に技術的エラーを出さない）
    }
  }, []);

  useEffect(() => {
    if (hasDeviceToken !== true) return;
    poll();
    pollTimer.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [hasDeviceToken, poll]);

  // 通話中の経過時間表示
  useEffect(() => {
    if (phase !== "in_call" || callStartedAt === null) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - callStartedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase, callStartedAt]);

  /** 通話状態をすべて片付けて待受へ戻る（leave 済みであること）。 */
  const resetToStandby = useCallback(() => {
    setPhase("standby");
    setCallId(null);
    setAnswerData(null);
    setCallStartedAt(null);
    setCallNotice(null);
  }, []);

  async function handleAnswer() {
    if (!callId) return;
    try {
      // answer が返す app_id/token/channel_name/uid(=2・高齢者) で入室する（M1）
      const res = await answerCall(callId);
      setAnswerData(res);
      setCallStartedAt(Date.now());
      setElapsed(0);
      setPhase("in_call");
    } catch {
      // 応答失敗時は待受に留まる（次のポーリングで着信状態を再確認）
    }
  }

  // 「でる」後の Agora 入室（in_call になり映像コンテナがマウントされてから join する）
  useEffect(() => {
    if (phase !== "in_call" || !answerData) return;
    let cancelled = false;
    let handle: CallHandle | null = null;

    (async () => {
      try {
        handle = await startCall({
          appId: answerData.app_id,
          channel: answerData.channel_name,
          token: answerData.token,
          uid: answerData.uid, // 高齢者=2（uid ルール。M2 検知はこのストリームに接続される）
          remoteContainer: remoteRef.current!,
          localContainer: localRef.current,
          onRemoteLeft: async () => {
            // 相手（家族側）が切った → 自動で待受へ復帰（WF-01④）
            await handleRef.current?.leave();
            handleRef.current = null;
            const id = callIdRef.current;
            if (id) {
              try {
                await endCall(id, "device"); // 冪等（相手が end 済みでも 200）
              } catch {
                // 終了処理のエラーは待受復帰を妨げない
              }
            }
            resetToStandby();
          },
        });
        if (cancelled) {
          await handle.leave();
          return;
        }
        handleRef.current = handle;
      } catch {
        if (cancelled) return;
        // 入室失敗（許可拒否・ネットワーク等）はやさしい文言を出して待受へ戻す
        setCallNotice("つなげませんでした。もういちど おかけなおしください");
        setTimeout(() => resetToStandby(), 4000);
      }
    })();

    return () => {
      cancelled = true;
      handleRef.current = null;
      handle?.leave();
    };
  }, [phase, answerData, resetToStandby]);

  async function handleHangup() {
    await handleRef.current?.leave();
    handleRef.current = null;
    const id = callIdRef.current;
    if (id) {
      try {
        await endCall(id, "device");
      } catch {
        // 終了APIの失敗は待受復帰を妨げない（incoming は120秒で失効する）
      }
    }
    resetToStandby();
  }

  async function handleShowMemory() {
    setVideoLoading(true);
    setVideoError(null);
    try {
      const album: Album = await getLatestAlbum();
      if (album.video_sas_url) {
        setVideoUrl(album.video_sas_url);
      } else {
        setVideoError("まだ どうがが ありません");
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setVideoError("まだ おもいでは ありません");
      } else {
        setVideoError("つうしんエラーが おきました");
      }
    } finally {
      setVideoLoading(false);
    }
  }

  if (hasDeviceToken === false) {
    return (
      <div className="elder-shell">
        <div style={{ fontSize: "4vw", fontWeight: 700 }}>
          まだ とうろく されていません
        </div>
        <div style={{ marginTop: 20, fontSize: "2.2vw", color: "#cfe0ea" }}>
          かぞくの かたから もらった リンクを ひらいてください
        </div>
      </div>
    );
  }

  return (
    <div className="elder-shell">
      {videoUrl && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "#000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 30,
          }}
        >
          <video src={videoUrl} controls autoPlay style={{ maxWidth: "100%", maxHeight: "100%" }} />
          <button
            className="btn-hangup"
            style={{ position: "absolute", top: 20, right: 20 }}
            onClick={() => setVideoUrl(null)}
          >
            とじる
          </button>
        </div>
      )}

      {phase === "standby" && !videoUrl && (
        <>
          <div className="elder-clock">
            {pad(now.getHours())}:{pad(now.getMinutes())}
          </div>
          <div className="elder-date">
            {now.getFullYear()}年{now.getMonth() + 1}月{now.getDate()}日
          </div>
          <div className="elder-status">● つながっています</div>

          <button className="btn-elder-action" onClick={handleShowMemory} disabled={videoLoading}>
            {videoLoading ? "よみこみちゅう…" : "さいきんの おもいで を みる"}
          </button>
          {videoError && (
            <div style={{ marginTop: 16, fontSize: "2vw", color: "#ffd7c9" }}>{videoError}</div>
          )}
        </>
      )}

      {phase === "incoming" && !videoUrl && (
        <div className="elder-incoming">
          <div className="elder-incoming-text">
            {familyName} から
            <br />
            でんわが きています
          </div>
          <button className="btn-answer" onClick={handleAnswer}>
            でる
          </button>
        </div>
      )}

      {phase === "in_call" && !videoUrl && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "#000",
            zIndex: 20,
          }}
        >
          {/* 相手映像（全画面・WF-01③）。Agora RemoteVideoTrack の描画先 */}
          <div ref={remoteRef} style={{ position: "absolute", inset: 0 }} />

          {/* 自分映像（小さく・左下）。publish 中のカメラ確認用 */}
          <div
            ref={localRef}
            style={{
              position: "absolute",
              left: 16,
              bottom: 16,
              width: "16vw",
              maxWidth: 220,
              aspectRatio: "4 / 3",
              background: "#111",
              borderRadius: 12,
              overflow: "hidden",
              border: "2px solid rgba(255,255,255,0.3)",
              zIndex: 21,
            }}
          />

          {/* 経過時間（小さく上部） */}
          <div
            style={{
              position: "absolute",
              top: 14,
              left: "50%",
              transform: "translateX(-50%)",
              fontSize: "2vw",
              color: "rgba(255,255,255,0.75)",
              zIndex: 21,
            }}
          >
            つうわちゅう {pad(Math.floor(elapsed / 60))}:{pad(elapsed % 60)}
          </div>

          {/* 入室失敗などのやさしい通知 */}
          {callNotice && (
            <div
              style={{
                position: "absolute",
                top: "45%",
                left: 0,
                right: 0,
                textAlign: "center",
                fontSize: "3vw",
                color: "#ffd7c9",
                zIndex: 22,
              }}
            >
              {callNotice}
            </div>
          )}

          {/* デバッグボタン（左下・自分映像小窓の上・控えめ）: パネルを開閉する。?debug=1 で初期表示ON。 */}
          <button
            data-testid="debug-toggle"
            onClick={() => setPanelOpen((v) => !v)}
            title="デバッグパネルを開閉"
            style={{
              position: "absolute",
              left: 16,
              top: 16,
              zIndex: 23,
              background: "rgba(0,0,0,0.5)",
              color: "rgba(255,255,255,0.6)",
              border: "1px solid rgba(255,255,255,0.25)",
              borderRadius: 6,
              fontSize: 10,
              lineHeight: 1.2,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            デバッグ
          </button>

          {/* デバッグパネル: autogain（level/ema/gain）・接続状態（joined/remote）・デバイス登録状態。
              等幅小フォント・半透明・スクロール可。 */}
          {panelOpen && (
            <div
              data-testid="autogain-debug"
              style={{
                position: "absolute",
                left: 16,
                top: 44,
                zIndex: 22,
                background: "rgba(0,0,0,0.82)",
                color: "#0f0",
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: 11,
                lineHeight: 1.4,
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid rgba(0,255,0,0.35)",
                minWidth: 170,
                maxWidth: 260,
                maxHeight: "min(60vh, 400px)",
                overflowY: "auto",
                userSelect: "none",
              }}
            >
              <div style={{ color: "#8f8", fontWeight: 700, marginBottom: 4 }}>
                elder debug
              </div>
              <div style={{ color: "#6d6", fontWeight: 700 }}>autogain</div>
              {autoGain?.enabled ? (
                <>
                  <div>
                    level:{" "}
                    {autoGain.measuredDbfs === null
                      ? "—"
                      : `${autoGain.measuredDbfs.toFixed(1)} dBFS`}
                  </div>
                  <div>
                    ema:{" "}
                    {autoGain.emaDbfs === null
                      ? "—"
                      : `${autoGain.emaDbfs.toFixed(1)} dBFS`}
                  </div>
                  <div style={{ color: "#6f6" }}>
                    gain: +{autoGain.gainDb.toFixed(1)} dB
                  </div>
                </>
              ) : (
                <div style={{ color: "#aa8" }}>未接続…</div>
              )}
              <div style={{ color: "#6d6", fontWeight: 700, marginTop: 6 }}>
                接続状態
              </div>
              <div>joined: {connState?.joined ? "YES" : "no"}</div>
              <div>remote: {connState?.remoteVideo ? "YES" : "no"}</div>
              <div style={{ color: "#6d6", fontWeight: 700, marginTop: 6 }}>
                デバイス
              </div>
              <div>
                登録:{" "}
                {hasDeviceToken === null
                  ? "確認中…"
                  : hasDeviceToken
                  ? "登録済み"
                  : "未登録"}
              </div>
            </div>
          )}

          {/* 「きる」は控えめに右下配置（WF-01③） */}
          <button
            className="btn-hangup"
            style={{
              position: "absolute",
              right: 16,
              bottom: 16,
              opacity: 0.85,
              zIndex: 21,
            }}
            onClick={handleHangup}
          >
            きる
          </button>
        </div>
      )}
    </div>
  );
}
