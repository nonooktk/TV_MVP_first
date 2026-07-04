"use client";

// WF-02: 通話画面（家族側・M1 で Agora 実通話に接続 / M2 で検知＋同期を統合）
//
// - 遷移時に POST /tokens/call（call_id）でトークンを取得し、modules/call/agoraCall.ts で
//   join・publish・subscribe する（uid=1・家族）。
// - 相手映像を大きく表示し、自分の映像を小窓で重ねる。
// - 「通話を終了する」→ leave ＋ POST /calls/{id}/end → 同期 → /select へ。
// - 相手が退出したら「通話が終了しました」→ 同期 → /select へ。
// - カメラ/マイクの許可拒否時は「カメラとマイクの利用を許可してください」画面（WF-02例外）。
//
// M2（コア②）統合:
// - agoraCall.ts の onRemoteMediaStreamTrack（uid=2 の高齢者ストリーム）から video/audio
//   トラックを集め、両方揃ったら modules/detection の attachDetection を接続する。
// - 「● AI記録中」バッジを実状態に: 検知稼働中は点灯、発火時に短くフラッシュ＋
//   「思い出を記録しました（N）」カウント表示。
// - 通話終了時に modules/sync の syncCallMedia を実行（「思い出を準備中…」表示）→
//   完了後 /select?call_id=... へ自動遷移。select が 404（worker 未処理）なら
//   「候補を準備中…」表示で3秒ポーリングして遷移する。
// - カメラ許可拒否等で検知が動かなくても通話自体は継続（検知は best-effort）。

import {
  CSSProperties,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { endCall, getCandidates, issueCallToken } from "../../lib/api-client";
import { ApiError } from "../../lib/api-client";
import {
  CallHandle,
  isPermissionDenied,
  startCall,
  UID_ELDER,
} from "../../modules/call/agoraCall";
import {
  attachDetection,
  type DetectionEvent,
  type DetectionHandle,
} from "../../modules/detection";
import { syncCallMedia } from "../../modules/sync";

// 相手退出後の遷移前クッション（ms）
const AUTO_LEAVE_DELAY_MS = 800;
// 発火バッジのフラッシュ表示時間（ms）
const FLASH_MS = 1500;
// /select 候補準備ポーリングの間隔（ms）
const SELECT_POLL_INTERVAL_MS = 3000;
// /select 候補準備ポーリングの最大待ち（ms）
const SELECT_POLL_TIMEOUT_MS = 30000;

type Phase =
  | "connecting"
  | "in_call"
  | "permission_denied"
  | "remote_ended"
  | "syncing"
  | "error";

export default function CallPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#111" }} />}>
      <CallPageInner />
    </Suspense>
  );
}

function CallPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callId = searchParams.get("call_id");

  const [phase, setPhase] = useState<Phase>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // 検知の実状態（バッジ表示用）
  const [detecting, setDetecting] = useState(false);
  const [memoryCount, setMemoryCount] = useState(0);
  const [flashing, setFlashing] = useState(false);
  // 同期の進行表示
  const [syncMessage, setSyncMessage] = useState("思い出を準備中…");

  const remoteRef = useRef<HTMLDivElement | null>(null);
  const localRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CallHandle | null>(null);

  // 検知の配線状態。uid=2 の video/audio トラックが揃ったら attach する。
  const detectionRef = useRef<DetectionHandle | null>(null);
  const tracksRef = useRef<{ video?: MediaStreamTrack; audio?: MediaStreamTrack }>({});
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 終了処理の多重実行防止
  const endingRef = useRef(false);

  // uid=2（高齢者）の生トラックを受け取り、video/audio が揃ったら検知を接続する。
  const onRemoteTrack = useCallback(
    (kind: "video" | "audio", track: MediaStreamTrack, uid: number) => {
      if (uid !== UID_ELDER) return; // 検知は高齢者ストリームのみ
      tracksRef.current[kind] = track;
      const { video, audio } = tracksRef.current;
      if (detectionRef.current || !callId) return;
      // 検知は RMS音圧（音声・主トリガー）＋ 連写/look-back/表情（映像）を使う。
      // 映像・音声の両方が揃ってから接続する（通話では相手が常にカメラ/マイクを
      // publish するため両方到着する。到着順は不定なので揃うのを待つ）。
      if (!audio || !video) return;
      const stream = new MediaStream();
      stream.addTrack(video);
      stream.addTrack(audio);
      try {
        detectionRef.current = attachDetection({
          stream,
          callId,
          onEvent: (ev: DetectionEvent) => {
            setMemoryCount((n) => n + ev.photoCount);
            setFlashing(true);
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
            flashTimerRef.current = setTimeout(() => setFlashing(false), FLASH_MS);
          },
        });
        setDetecting(true);
      } catch (e) {
        // 検知の失敗は通話を止めない（best-effort）。
        // eslint-disable-next-line no-console
        console.warn("[call] 検知の接続に失敗（通話は継続）", e);
      }
    },
    [callId]
  );

  // join シーケンス（attempt が進むたびにやり直す）
  useEffect(() => {
    if (!callId) {
      setPhase("error");
      setErrorMessage("call_id が指定されていません");
      return;
    }
    let cancelled = false;
    let handle: CallHandle | null = null;

    (async () => {
      try {
        setPhase("connecting");
        const tok = await issueCallToken(callId);
        if (cancelled) return;
        handle = await startCall({
          appId: tok.app_id,
          channel: tok.channel_name,
          token: tok.token,
          uid: tok.uid, // 家族=1
          remoteContainer: remoteRef.current!,
          localContainer: localRef.current,
          onRemoteMediaStreamTrack: onRemoteTrack,
          onRemoteLeft: () => setPhase("remote_ended"),
        });
        if (cancelled) {
          await handle.leave();
          return;
        }
        handleRef.current = handle;
        setPhase("in_call");
      } catch (e) {
        if (cancelled) return;
        if (isPermissionDenied(e)) {
          setPhase("permission_denied");
        } else {
          setPhase("error");
          setErrorMessage(
            e instanceof Error ? e.message : "通話への接続に失敗しました"
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      handleRef.current = null;
      detectionRef.current?.detach();
      detectionRef.current = null;
      tracksRef.current = {};
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      handle?.leave();
    };
  }, [callId, attempt, onRemoteTrack]);

  // /select 遷移前に候補の準備を待つ（404=worker 未処理なら3秒ポーリング）。
  const waitForCandidatesThenGo = useCallback(async () => {
    if (!callId) {
      router.push("/");
      return;
    }
    const deadline = Date.now() + SELECT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await getCandidates(callId);
        break; // 候補あり（またはアルバム作成済み）→ 遷移
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
          setSyncMessage("候補を準備中…");
          await new Promise((r) => setTimeout(r, SELECT_POLL_INTERVAL_MS));
          continue;
        }
        break; // その他のエラーはそのまま遷移（/select 側で扱う）
      }
    }
    router.push(`/select?call_id=${callId}`);
  }, [callId, router]);

  // 通話終了 → 検知停止 → end → 同期 → /select 遷移（終了系の共通処理）。
  const finishAndSync = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;

    // 検知を止めてから同期する（発火中の書き込みを止める）。
    detectionRef.current?.detach();
    detectionRef.current = null;
    await handleRef.current?.leave();
    handleRef.current = null;

    if (callId) {
      try {
        await endCall(callId, "family"); // 冪等
      } catch {
        // end の失敗は同期・遷移を妨げない
      }
    }

    setPhase("syncing");
    setSyncMessage("思い出を準備中…");
    let registered = 0;
    if (callId) {
      try {
        const res = await syncCallMedia(callId);
        registered = res.registered;
      } catch {
        // 同期失敗時もデータは IndexedDB に残る（ホームで再同期される）。
        router.push("/");
        return;
      }
    }
    // 記録が1件も無ければ候補は生成されない。ホームへ戻る。
    if (registered === 0) {
      router.push("/");
      return;
    }
    await waitForCandidatesThenGo();
  }, [callId, router, waitForCandidatesThenGo]);

  // 相手退出 → 少し待って終了・同期へ。
  useEffect(() => {
    if (phase !== "remote_ended") return;
    const t = setTimeout(() => void finishAndSync(), AUTO_LEAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [phase, finishAndSync]);

  // 「通話を終了する」
  const handleEnd = useCallback(() => {
    void finishAndSync();
  }, [finishAndSync]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#111",
        color: "#fff",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* 相手映像（大） */}
      <div ref={remoteRef} style={{ position: "absolute", inset: 0, background: "#000" }} />

      {/* 自分映像（小窓） */}
      <div
        ref={localRef}
        style={{
          position: "absolute",
          right: 16,
          bottom: 96,
          width: 180,
          aspectRatio: "4 / 3",
          background: "#222",
          borderRadius: 12,
          overflow: "hidden",
          border: "2px solid rgba(255,255,255,0.35)",
          zIndex: 5,
        }}
      />

      {/* コア②（検知キャプチャ）稼働バッジ: 実状態に連動。発火時にフラッシュ＋カウント。 */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          zIndex: 5,
        }}
      >
        <div
          style={{
            background: flashing
              ? "rgba(74,200,120,0.95)"
              : detecting
              ? "rgba(232,115,74,0.9)"
              : "rgba(120,120,120,0.7)",
            padding: "6px 14px",
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 700,
            transition: "background 0.2s",
          }}
        >
          {flashing ? "● 記録中！" : detecting ? "● AI記録中" : "○ AI準備中"}
        </div>
        {memoryCount > 0 && (
          <div
            style={{
              background: "rgba(0,0,0,0.55)",
              padding: "3px 10px",
              borderRadius: 999,
              fontSize: 12,
            }}
          >
            思い出を記録しました（{memoryCount}）
          </div>
        )}
      </div>

      {/* 通話終了ボタン */}
      {(phase === "in_call" || phase === "connecting") && (
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            zIndex: 5,
          }}
        >
          <button
            className="btn-primary"
            style={{ maxWidth: 280, background: "var(--color-danger)" }}
            onClick={handleEnd}
          >
            通話を終了する
          </button>
        </div>
      )}

      {/* 接続中表示 */}
      {phase === "connecting" && (
        <div style={overlayStyle}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>接続中…</div>
          <p style={{ fontSize: 13, color: "#bbb" }}>
            相手が「でる」を押すと映像がつながります
          </p>
        </div>
      )}

      {/* カメラ/マイク許可拒否（WF-02例外） */}
      {phase === "permission_denied" && (
        <div style={overlayStyle}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            カメラとマイクの利用を許可してください
          </div>
          <p style={{ maxWidth: 380, fontSize: 14, color: "#ccc" }}>
            通話にはカメラとマイクが必要です。ブラウザのアドレスバー付近の
            カメラアイコンから許可に変更し、「許可して再開」を押してください。
          </p>
          <button
            className="btn-primary"
            style={{ maxWidth: 240 }}
            onClick={() => setAttempt((n) => n + 1)}
          >
            許可して再開
          </button>
          <button className="btn-secondary" style={{ maxWidth: 240 }} onClick={handleEnd}>
            通話をやめる
          </button>
        </div>
      )}

      {/* 相手が退出 */}
      {phase === "remote_ended" && (
        <div style={overlayStyle}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>通話が終了しました</div>
          <p style={{ fontSize: 13, color: "#bbb" }}>思い出を準備しています…</p>
        </div>
      )}

      {/* 同期中（思い出を準備中／候補を準備中） */}
      {phase === "syncing" && (
        <div style={overlayStyle}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{syncMessage}</div>
          <p style={{ fontSize: 13, color: "#bbb" }}>
            記録した思い出をアップロードしています。しばらくお待ちください。
          </p>
        </div>
      )}

      {/* その他のエラー */}
      {phase === "error" && (
        <div style={overlayStyle}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>接続できませんでした</div>
          {errorMessage && (
            <p style={{ maxWidth: 380, fontSize: 13, color: "#ccc" }}>{errorMessage}</p>
          )}
          <button
            className="btn-secondary"
            style={{ maxWidth: 240 }}
            onClick={() => router.push("/")}
          >
            ホームに戻る
          </button>
        </div>
      )}
    </div>
  );
}

// 全画面オーバーレイの共通スタイル
const overlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(17,17,17,0.82)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  padding: 24,
  textAlign: "center",
  zIndex: 10,
};
