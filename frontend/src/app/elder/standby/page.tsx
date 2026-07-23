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
  AnswerResponse,
  answerCall,
  endCall,
  getDeviceToken,
  getLatestAlbum,
  pollIncomingCall,
} from "../../../lib/api-client";
import {
  nextOnPoll,
  recoverOnError,
  type PlayingAlbum,
} from "../../../modules/standbyAlbum";
import {
  CallHandle,
  startCall,
  type AutoGainDebugState,
  type CallState,
} from "../../../modules/call/agoraCall";

const POLL_INTERVAL_MS = 3000;
// 待受アルバムの最新確認の間隔（60秒ごとに GET /albums/latest を再確認する・B-2）。
const ALBUM_POLL_INTERVAL_MS = 60000;

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
  // 相手（発信者）の表示ラベル。着信ポーリングの caller_display_name 優先 → family_name
  // フォールバックで解決した値（両方 null なら null＝ラベル非表示）。機能A・A-4。
  const [callerName, setCallerName] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [answerData, setAnswerData] = useState<AnswerResponse | null>(null);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [hasDeviceToken, setHasDeviceToken] = useState<boolean | null>(null);
  const [callNotice, setCallNotice] = useState<string | null>(null);

  // 待受アルバムの自動ループ再生（B-2）。playing=現在再生中の再生対象（未再生は null）。
  // muted=音声ミュート（既定ミュート。ミュートでないと自動再生がブラウザにブロックされる）。
  const [playing, setPlaying] = useState<PlayingAlbum | null>(null);
  const [muted, setMuted] = useState(true);
  // check() から最新の再生中識別子を参照するための ref（差し替え判定用）。
  const playingRef = useRef<PlayingAlbum | null>(null);
  playingRef.current = playing;
  // onError 再取得の多重実行防止（連続エラー時のフェッチ暴走を防ぐ）。
  const recoveringRef = useRef(false);
  // <video> 要素（muted プロパティを ref 経由で同期する。React の muted 属性は不安定なため）。
  const videoRef = useRef<HTMLVideoElement | null>(null);

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
        // 相手名: 発信者自身の表示名（caller_display_name）を優先し、無ければ家族名
        // （family_name）へフォールバック。両方 null なら null（in_call ラベルは非表示）。
        setCallerName(status.caller_display_name ?? status.family_name ?? null);
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

  // 待受アルバムの自動ループ再生（B-2）。
  // 待受中（phase=standby・デバイス登録済み）のみ、GET /albums/latest を取得して
  // 全画面背景で自動再生する。60秒ごとに再確認し、id/version が変わったときだけ src を
  // 差し替える（差し替え判定は純粋関数 nextOnPoll）。404 等は静かに無視（現在の再生を維持）。
  // 着信・通話中は effect が early return して再生を止め（video も非表示）、待受復帰で再開する。
  useEffect(() => {
    if (hasDeviceToken !== true || phase !== "standby") return;
    let cancelled = false;

    const check = async (): Promise<void> => {
      try {
        const album = await getLatestAlbum();
        if (cancelled) return;
        const next = nextOnPoll(playingRef.current, album);
        if (next) setPlaying(next);
      } catch {
        // 404（アルバム未生成）・通信エラーは静かに無視する（現在の再生は維持。
        // 初期状態では playing=null のまま＝何も表示しない）。
      }
    };

    void check();
    const t = setInterval(() => void check(), ALBUM_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [hasDeviceToken, phase]);

  // <video> の onError（SAS 15分期限切れ等）→ 最新 SAS を再取得して張り直し自動復帰（B-2）。
  // 識別子が同一でも SAS は変わるため recoverOnError は常に新しい再生対象を返す。
  // recoveringRef で多重実行を防ぎ、連続エラー時のフェッチ暴走を避ける。
  const handleVideoError = useCallback(async (): Promise<void> => {
    if (recoveringRef.current) return;
    recoveringRef.current = true;
    try {
      const album = await getLatestAlbum();
      const next = recoverOnError(album);
      if (next) setPlaying(next);
    } catch {
      // 復帰できない場合は静かに何もしない（次の定期確認で再取得される）。
    } finally {
      recoveringRef.current = false;
    }
  }, []);

  // muted の同期（React の muted 属性は反映が不安定なため DOM プロパティで確実に設定する）。
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted, playing]);

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
      {phase === "standby" && (
        <>
          {/* 待受アルバムの自動ループ再生（B-2）: 最新ハイライト動画を全画面背景で流す。
              未生成（playing=null）のときは何も出さず、従来どおり時計だけを表示する。
              key を id/version にして、別アルバムに変わったときはクリーンに再マウントする
              （同一アルバムの SAS 張り直し〈onError〉では key 不変・src だけ更新でループ継続）。 */}
          {playing && (
            <>
              <video
                ref={videoRef}
                key={`${playing.id}:${playing.version}`}
                src={playing.videoUrl}
                autoPlay
                muted={muted}
                loop
                playsInline
                onError={() => void handleVideoError()}
                data-testid="standby-album-video"
                style={{
                  position: "fixed",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  background: "#000",
                  zIndex: 0,
                }}
              />
              {/* 画面隅の小さなミュート切替（既定ミュート・タップで音声オン/オフ）。 */}
              <button
                data-testid="standby-mute-toggle"
                onClick={() => setMuted((v) => !v)}
                title={muted ? "音を出す" : "音を消す"}
                style={{
                  position: "fixed",
                  right: "2vw",
                  top: "2vw",
                  zIndex: 3,
                  background: "rgba(0,0,0,0.5)",
                  color: "#fff",
                  border: "1px solid rgba(255,255,255,0.35)",
                  borderRadius: 999,
                  fontSize: "1.8vw",
                  padding: "0.6vw 1.6vw",
                  cursor: "pointer",
                }}
              >
                {muted ? "🔇 おと オフ" : "🔊 おと オン"}
              </button>
            </>
          )}

          {/* 時計・日付・状態（アルバム再生中はその上に重ねて表示する）。 */}
          <div
            style={{
              position: "relative",
              zIndex: 1,
              textShadow: playing ? "0 2px 8px rgba(0,0,0,0.8)" : undefined,
            }}
          >
            <div className="elder-clock">
              {pad(now.getHours())}:{pad(now.getMinutes())}
            </div>
            <div className="elder-date">
              {now.getFullYear()}年{now.getMonth() + 1}月{now.getDate()}日
            </div>
            <div className="elder-status">● つながっています</div>
          </div>
        </>
      )}

      {phase === "incoming" && (
        <div className="elder-incoming">
          <div className="elder-incoming-text">
            {callerName ?? "かぞく"} から
            <br />
            でんわが きています
          </div>
          <button className="btn-answer" onClick={handleAnswer}>
            でる
          </button>
        </div>
      )}

      {phase === "in_call" && (
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

          {/* 相手の名前ラベル（Zoom風・左下）。caller_display_name 優先 → family_name
              フォールバックで解決した callerName（両方 null なら非表示）。機能A・A-4。 */}
          {callerName && (
            <div
              data-testid="elder-remote-name-label"
              style={{
                position: "absolute",
                left: "3vw",
                bottom: "3vw",
                maxWidth: "50%",
                background: "rgba(0,0,0,0.55)",
                color: "#fff",
                padding: "0.5vw 1.4vw",
                borderRadius: 10,
                fontSize: "2.2vw",
                fontWeight: 700,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                zIndex: 22,
              }}
            >
              {callerName}
            </div>
          )}

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
