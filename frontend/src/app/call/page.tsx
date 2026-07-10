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
  type AutoGainDebugState,
} from "../../modules/call/agoraCall";
import {
  attachDetection,
  type DetectionEvent,
  type DetectionHandle,
  type DetectionRuntimeState,
  type FaceHealthState,
} from "../../modules/detection";
import { DEFAULT_RMS_PARAMS } from "../../modules/detection/rmsTrigger";
import { DEFAULT_CENTROID_PARAMS } from "../../modules/detection/centroidTrigger";
import { DEFAULT_FACE_TRIGGER_PARAMS } from "../../modules/detection/faceTrigger";
import { countByCall } from "../../modules/detection/storage";
import { syncCallMedia } from "../../modules/sync";
import FamilyAuthGate from "../../components/FamilyAuthGate";

// 相手退出後の遷移前クッション（ms）
const AUTO_LEAVE_DELAY_MS = 800;
// 発火バッジのフラッシュ表示時間（ms）
const FLASH_MS = 1500;
// /select 候補準備ポーリングの間隔（ms）
const SELECT_POLL_INTERVAL_MS = 3000;
// /select 候補準備ポーリングの最大待ち（ms）
const SELECT_POLL_TIMEOUT_MS = 30000;
// 写真ゼロ通話の通知（「思い出を記録できませんでした」）の表示時間（ms）。
// 表示中でも画面タップで即ホームへ戻れる。
const NO_MEMORIES_NOTICE_MS = 3000;

type Phase =
  | "connecting"
  | "in_call"
  | "permission_denied"
  | "remote_ended"
  | "syncing"
  | "no_memories"
  | "error";

export default function CallPage() {
  // 家族側ページのため FamilyAuthGate でラップ（Entra 有効時は要サインイン）。
  return (
    <FamilyAuthGate>
      <Suspense fallback={<div style={{ minHeight: "100vh", background: "#111" }} />}>
        <CallPageInner />
      </Suspense>
    </FamilyAuthGate>
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
  // 記録通知の2段階化（改良3）: started で「記録中…」を表示、completed で解除する。
  const [recording, setRecording] = useState(false);
  // 表情検知（MediaPipe）の稼働状態。バッジに「顔検知OK/停止中」を小さく出す。
  const [faceHealth, setFaceHealth] = useState<FaceHealthState>("loading");
  // 停止（failed）時の理由。バッジに短縮理由を併記し、詳細は title 属性に出す。
  const [faceReason, setFaceReason] = useState<string | null>(null);
  // 同期の進行表示
  const [syncMessage, setSyncMessage] = useState("思い出を準備中…");

  // デバッグパネル: 画面隅の「デバッグ」ボタンで開閉する。?debug=1 で初期表示ON（後方互換）。
  const debug = searchParams.get("debug") === "1";
  const [panelOpen, setPanelOpen] = useState(debug);
  const [debugState, setDebugState] = useState<DetectionRuntimeState | null>(null);
  // 自分側（家族・uid=1）マイクの自動ゲイン観測値（window.__autoGainFamily）。
  const [autoGainFamily, setAutoGainFamily] =
    useState<AutoGainDebugState | null>(null);
  // この通話の IndexedDB 保存件数（写真・音声スニペット）。1秒間隔の軽いポーリング。
  const [dbCounts, setDbCounts] = useState<{ photos: number; audio: number } | null>(
    null
  );
  // 最終キャプチャ（発火イベント）時刻。
  const [lastCaptureAt, setLastCaptureAt] = useState<Date | null>(null);
  // 計測ログ（読み取り専用オブザーバー）の現在の記録件数（samples/events）。200ms 間隔ポーリング。
  const [measurementCounts, setMeasurementCounts] = useState<{
    samples: number;
    events: number;
  } | null>(null);

  const remoteRef = useRef<HTMLDivElement | null>(null);
  const localRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CallHandle | null>(null);

  // 検知の配線状態。uid=2 の video/audio トラックが揃ったら attach する。
  const detectionRef = useRef<DetectionHandle | null>(null);
  const tracksRef = useRef<{ video?: MediaStreamTrack; audio?: MediaStreamTrack }>({});
  // 声トリガーの両側化（family lane）: 自分（家族・uid=1）のローカルマイクの生トラック。
  // agoraCall.ts の onLocalAudioTrack から join 直後（許可取得後）に届く。
  const localAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  // 顔検知の家族側化・両側連写（Phase 2）: 自分（家族・uid=1）のローカルカメラの生トラック。
  // agoraCall.ts の onLocalVideoTrack から join 直後（許可取得後）に届く。
  const localVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 終了処理の多重実行防止
  const endingRef = useRef(false);

  // uid=2（高齢者）の生トラックを受け取り、video/audio が揃ったら検知を接続する。
  //
  // 【family lane のタイミングに関する設計判断】
  // 家族側ローカルマイクの生トラック（localAudioTrackRef）は join 直後（相手が「でる」より
  // 前）に届くため、通常は elder の video/audio より先に揃っている。attach 時点で
  // localAudioTrackRef.current が未取得（極めて稀・タイミング次第）でも、family lane を
  // 諦めて elder レーンのみで検知を続行する（best-effort。attachDetection は
  // familyAudioTrack 省略時は family lane を単に有効化しないだけで、elder 側の検知・通話
  // 自体は妨げない）。attach 後に family トラックが遅れて届いても再接続はしない
  // （実運用では起こりにくいタイミングのため、次フェーズで必要になれば動的追加を検討する）。
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
          familyAudioTrack: localAudioTrackRef.current,
          familyVideoTrack: localVideoTrackRef.current,
          onEvent: (ev: DetectionEvent) => {
            if (ev.type === "started") {
              // トリガー瞬間（即時）: バッジを即フラッシュし「思い出を記録中…」を出す。
              setRecording(true);
              setLastCaptureAt(new Date());
              setFlashing(true);
              if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
              flashTimerRef.current = setTimeout(() => setFlashing(false), FLASH_MS);
            } else {
              // 保存完了（部分保存でも実枚数）: 記録カウントを更新し「記録中…」を解除する。
              setMemoryCount((n) => n + ev.photoCount);
              setRecording(false);
            }
          },
          onFaceHealth: (state, reason) => {
            setFaceHealth(state);
            setFaceReason(reason);
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
          // 声トリガーの両側化（family lane）: 自分（家族）のローカルマイクの生トラックを保持する。
          onLocalAudioTrack: (track) => {
            localAudioTrackRef.current = track;
          },
          // 顔検知の家族側化・両側連写（Phase 2）: 自分（家族）のローカルカメラの生トラックを保持する。
          onLocalVideoTrack: (track) => {
            localVideoTrackRef.current = track;
          },
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
      localAudioTrackRef.current = null;
      localVideoTrackRef.current = null;
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
    // 記録が1件も無ければ候補は生成されない。
    // 無言でホームへ戻らず「思い出を記録できませんでした」を数秒表示してから戻る。
    if (registered === 0) {
      setPhase("no_memories");
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

  // 写真ゼロ通話の通知 → 3秒表示後にホームへ（タップで即戻れる）。
  useEffect(() => {
    if (phase !== "no_memories") return;
    const t = setTimeout(() => router.push("/"), NO_MEMORIES_NOTICE_MS);
    return () => clearTimeout(t);
  }, [phase, router]);

  // デバッグパネル: window.__detection.state と window.__autoGainFamily を 200ms 間隔でポーリング。
  useEffect(() => {
    if (!panelOpen) return;
    const t = setInterval(() => {
      if (typeof window === "undefined") return;
      setDebugState(window.__detection?.state ?? null);
      setAutoGainFamily(window.__autoGainFamily ?? null);
      setMeasurementCounts(detectionRef.current?.measurementLogCounts() ?? null);
    }, 200);
    return () => clearInterval(t);
  }, [panelOpen]);

  // デバッグパネル: この通話の IndexedDB 件数（写真/音声）を1秒間隔で軽くポーリング。
  useEffect(() => {
    if (!panelOpen || !callId) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const counts = await countByCall(callId);
        if (!cancelled) setDbCounts(counts);
      } catch {
        // IndexedDB 未初期化などは無視（次回ポーリングで再試行）
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [panelOpen, callId]);

  // 「通話を終了する」
  const handleEnd = useCallback(() => {
    void finishAndSync();
  }, [finishAndSync]);

  // 「計測ログDL」: measurementLog.toExport() の JSON を Blob + a.download でダウンロードする。
  // ファイル名は measurement-log-<callId>-<t>.json（t は Date.now）。
  const handleMeasurementDownload = useCallback(() => {
    const handle = detectionRef.current;
    if (!handle) return;
    const data = handle.exportMeasurementLog();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `measurement-log-${callId ?? "unknown"}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [callId]);

  // 「ログクリア」: 計測ログ（samples/events）を空にする。
  const handleMeasurementClear = useCallback(() => {
    detectionRef.current?.clearMeasurementLog();
    setMeasurementCounts(detectionRef.current?.measurementLogCounts() ?? null);
  }, []);

  // 計測UI（📊ログ常設ボタン・ホームの回収セクション）の表示可否。
  // NEXT_PUBLIC_MEASUREMENT_UI="1" のときのみ表示（未設定なら非表示）。
  // ビルド時（Next.js 静的エクスポート）に埋め込まれる値を参照する。
  const measurementUiEnabled = process.env.NEXT_PUBLIC_MEASUREMENT_UI === "1";

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
            background:
              flashing || recording
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
          {recording
            ? "📸 思い出を記録中…"
            : flashing
            ? "● 記録中！"
            : detecting
            ? "● AI記録中"
            : "○ AI準備中"}
        </div>
        {/* 表情検知（MediaPipe）の稼働状態。ユーザーが不調に気づけるように小さく出す。 */}
        {detecting && (
          <div
            style={{
              background:
                faceHealth === "ok"
                  ? "rgba(0,0,0,0.55)"
                  : faceHealth === "failed"
                  ? "rgba(200,60,60,0.75)"
                  : "rgba(0,0,0,0.45)",
              padding: "2px 9px",
              borderRadius: 999,
              fontSize: 11,
              color: faceHealth === "ok" ? "#cfe" : "#fff",
            }}
            title={
              faceHealth === "failed" && faceReason
                ? `表情検知が停止中: ${faceReason}`
                : "表情検知（笑顔スコア）の状態"
            }
          >
            {faceHealth === "ok"
              ? "😊 顔検知OK"
              : faceHealth === "no_face"
              ? "🙂 顔をさがしています"
              : faceHealth === "loading"
              ? "⏳ 表情検知を準備中"
              : `⚠️ 表情検知が停止中${shortFaceReason(faceReason)}`}
          </div>
        )}
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

      {/* 写真ゼロ通話の通知（3秒表示→自動でホームへ。タップで即戻る） */}
      {phase === "no_memories" && (
        <div
          style={{ ...overlayStyle, cursor: "pointer" }}
          data-testid="no-memories-notice"
          onClick={() => router.push("/")}
        >
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            今回の通話では思い出を記録できませんでした
          </div>
          <p style={{ maxWidth: 380, fontSize: 13, color: "#bbb" }}>
            盛り上がった声や「かわいいね」などの言葉で自動記録されます
          </p>
          <p style={{ fontSize: 12, color: "#888" }}>
            まもなくホームへ戻ります（タップですぐ戻る）
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

      {/* デバッグボタン（右下隅・控えめ）: パネルを開閉する。?debug=1 で初期表示ON。 */}
      <button
        data-testid="debug-toggle"
        style={debugToggleStyle}
        onClick={() => setPanelOpen((v) => !v)}
        title="デバッグパネルを開閉"
      >
        デバッグ
      </button>

      {/* 常設「📊ログ」ボタン（左下・控えめ）: タップで計測ログJSONを即ダウンロードする。
          既存のデバッグパネル内「計測ログDL」と同じロジック（handleMeasurementDownload）を
          共有する。NEXT_PUBLIC_MEASUREMENT_UI=1 のときのみ表示。 */}
      {measurementUiEnabled && (
        <button
          data-testid="measurement-quick-download"
          style={measurementQuickButtonStyle}
          onClick={handleMeasurementDownload}
          title="計測ログJSONをダウンロード"
        >
          📊ログ
        </button>
      )}

      {/* 統合デバッグパネル: 発火・パラメータ・表情・STT・写真・自分側マイクをライブ表示。 */}
      {panelOpen && (
        <DebugPanel
          state={debugState}
          autoGain={autoGainFamily}
          dbCounts={dbCounts}
          lastCaptureAt={lastCaptureAt}
          measurementCounts={measurementCounts}
          onMeasurementDownload={handleMeasurementDownload}
          onMeasurementClear={handleMeasurementClear}
        />
      )}
    </div>
  );
}

// 統合デバッグパネル。画面右下隅に等幅小フォント・半透明背景で、検知・パラメータ・表情・
// STT・写真（IndexedDB）・自分側マイク autogain をセクション別にライブ表示する。
// 情報が増えても画面を覆わないよう max-height + スクロール可とする。
interface DebugPanelProps {
  state: DetectionRuntimeState | null;
  /** 自分側（家族・uid=1）マイクの自動ゲイン観測値。 */
  autoGain: AutoGainDebugState | null;
  /** この通話の IndexedDB 保存件数（写真・音声スニペット）。 */
  dbCounts: { photos: number; audio: number } | null;
  /** 最終キャプチャ（発火イベント）時刻。 */
  lastCaptureAt: Date | null;
  /** 計測ログ（読み取り専用オブザーバー）の現在の記録件数（samples/events）。 */
  measurementCounts: { samples: number; events: number } | null;
  /** 「計測ログDL」ボタンのハンドラ。 */
  onMeasurementDownload: () => void;
  /** 「ログクリア」ボタンのハンドラ。 */
  onMeasurementClear: () => void;
}

function DebugPanel({
  state,
  autoGain,
  dbCounts,
  lastCaptureAt,
  measurementCounts,
  onMeasurementDownload,
  onMeasurementClear,
}: DebugPanelProps) {
  const rms = state?.rms;
  const centroid = state?.centroid;
  const stt = state?.stt;
  const P = DEFAULT_RMS_PARAMS;
  const fmt = (v: number | null | undefined, d = 1): string =>
    v === null || v === undefined ? "—" : v.toFixed(d);
  // STT 直近テキストは末尾30字のみ（パネルを横に広げない）。
  const sttTail =
    stt?.lastText && stt.lastText.length > 0
      ? (stt.lastText.length > 30 ? "…" : "") + stt.lastText.slice(-30)
      : "—";
  const sections: Array<[string, Array<[string, string]>]> = [
    [
      "発火",
      [
        ["rms_dB", fmt(rms?.lastRmsDb)],
        ["baseline_dB", fmt(rms?.baselineDb)],
        ["rise", rms?.riseDb == null ? "—" : `+${fmt(rms.riseDb)}dB`],
        ["sustain", `${Math.round(rms?.sustainedMs ?? 0)}ms`],
        ["cooldown", `${((rms?.cooldownRemainingMs ?? 0) / 1000).toFixed(1)}s`],
        // リアーム状態（2026-07-07 追加）: 発火後は false → rise が閾値未満に戻ると true。
        ["armed", rms == null ? "—" : rms.armed ? "済" : "未（高止まり中）"],
        // ノイズゲート（固定 -50dB・2026-07-10 追加）: 現在フレームがゲート未満か。
        ["gated（ノイズゲート）", rms == null ? "—" : rms.gated ? "YES（無音扱い）" : "no"],
        ["busy", state?.busy ? "YES" : "no"],
        ["triggers", String(state?.triggerCount ?? 0)],
      ],
    ],
    [
      // 調整議論用にパラメータ現在値を明示する（モード連動・2026-07-07）:
      // rise_th は現行モード（仮基準+24dB／発話基準+12dB）の値をそのまま表示する。
      // sustainMs 150ms・cooldownMs 8s・動的 vadFloor・ノイズゲート（固定）・
      // baseline 学習の凍結状態と非対称τ。
      "パラメータ現在値",
      [
        [
          "rise_th（モード連動）",
          rms == null
            ? "—"
            : `+${rms.riseThresholdDb}dB (${
                rms.mode === "speech" ? "発話基準" : "仮基準"
              })`,
        ],
        ["sustainMs", `${P.sustainMs}ms`],
        ["cooldownMs", `${(P.cooldownMs / 1000).toFixed(0)}s`],
        ["vadFloor(動的)", rms?.vadFloorDb == null ? "—" : `${fmt(rms.vadFloorDb)}dB`],
        [
          // ノイズゲート（固定・2026-07-10 追加）: vadFloor の値に関わらず常にこの値未満は無音。
          "noiseGate(固定)",
          rms?.noiseGateDb == null ? "—" : `${fmt(rms.noiseGateDb)}dB`,
        ],
        [
          // baseline 学習の状態（静音区間ベース）: 凍結中か学習中か＋非対称τ（仮初期値 -32）。
          "baseline学習",
          rms == null
            ? "—"
            : `${rms.frozen ? "凍結中" : "学習中"} (↑τ${
                P.baselineTauUpMs / 1000
              }s/↓τ${P.baselineTauDownMs / 1000}s・仮${P.provisionalBaselineDb}dB)`,
        ],
      ],
    ],
    [
      // 基準レベルの2段階化（改良1・発話基準）: 現在モード・発話蓄積秒・発話メジアン。
      "基準モード（発話基準）",
      [
        [
          "mode",
          rms == null ? "—" : rms.mode === "speech" ? "発話基準" : "仮基準",
        ],
        [
          "発話蓄積",
          rms == null
            ? "—"
            : `${(rms.speechAccumMs / 1000).toFixed(1)}s / ${(
                P.speechAccumMs / 1000
              ).toFixed(0)}s`,
        ],
        [
          "発話メジアン",
          rms?.speechMedianDb == null ? "—" : `${fmt(rms.speechMedianDb)}dB`,
        ],
      ],
    ],
    [
      // スペクトル重心トリガー（改良2）: 現在値/基準/上昇率/持続。
      "重心（声色）",
      [
        [
          "重心",
          centroid?.lastCentroidHz == null
            ? "—"
            : `${Math.round(centroid.lastCentroidHz)}Hz`,
        ],
        [
          "基準",
          centroid?.baselineHz == null
            ? "—"
            : `${Math.round(centroid.baselineHz)}Hz`,
        ],
        [
          "上昇率",
          centroid?.riseRatio == null
            ? "—"
            : `${centroid.riseRatio.toFixed(2)}x / ${DEFAULT_CENTROID_PARAMS.riseRatio.toFixed(
                1
              )}x`,
        ],
        [
          "持続",
          `${Math.round(centroid?.sustainedMs ?? 0)}ms / ${DEFAULT_CENTROID_PARAMS.sustainMs}ms`,
        ],
        // リアーム状態（2026-07-07 追加）: 発火後は false → 基準比が閾値未満に戻ると true。
        ["armed", centroid == null ? "—" : centroid.armed ? "済" : "未（高止まり中）"],
      ],
    ],
    [
      "表情",
      [
        [
          "health",
          state == null
            ? "—"
            : state.faceHealth +
              (state.faceHealth === "failed" && state.faceReason
                ? `(${state.faceReason})`
                : ""),
        ],
        ["face_score", fmt(state?.lastFaceScore, 2)],
        ["source", state?.face.source ?? "—"],
        ["loadMs", state == null ? "—" : String(Math.round(state.face.loadMs))],
      ],
    ],
    [
      "STT",
      [
        ["enabled", stt?.enabled ? "on" : "off"],
        ["text", sttTail],
        ["labelヒット", stt && stt.labelHits.length > 0 ? stt.labelHits.join(",") : "—"],
        ["stt発火数", String(stt?.triggerCount ?? 0)],
      ],
    ],
    [
      // 声トリガーの両側化（family lane・2026-07-10 追加）: 家族側ローカルマイクの
      // 第2検知系統（elder レーンとは独立の baseline/発話累計/リアーム）。
      // familyAudioTrack 未接続の通話ではすべて「—」（未接続）表示になる。
      "家族側マイク（第2系統）",
      [
        ["rms_dB", fmt(state?.family?.rmsDb)],
        ["baseline_dB", fmt(state?.family?.baselineDb)],
        [
          "rise",
          state?.family?.riseDb == null ? "—" : `+${fmt(state.family.riseDb)}dB`,
        ],
        [
          "mode",
          state?.family == null
            ? "—"
            : state.family.mode === "speech"
            ? "発話基準"
            : "仮基準",
        ],
        [
          "armed",
          state?.family == null ? "—" : state.family.armed ? "済" : "未（高止まり中）",
        ],
        [
          "重心比",
          state?.family?.centroidRiseRatio == null
            ? "—"
            : `${state.family.centroidRiseRatio.toFixed(2)}x`,
        ],
      ],
    ],
    [
      // 顔トリガー（家族側の表情スコア発火・Phase 2）: 現在スコア/絶対閾値/持続/armed。
      // familyVideoTrack 未接続（顔検知なし）の通話ではすべて「—」表示になる。
      "顔トリガー（家族側）",
      [
        ["face_score", fmt(state?.faceTrigger?.lastScore, 2)],
        [
          "閾値",
          state?.faceTrigger == null
            ? "—"
            : `${state.faceTrigger.threshold.toFixed(2)}`,
        ],
        [
          "持続",
          state?.faceTrigger == null
            ? "—"
            : `${Math.round(state.faceTrigger.sustainedMs)}ms / ${DEFAULT_FACE_TRIGGER_PARAMS.sustainMs}ms`,
        ],
        [
          "armed",
          state?.faceTrigger == null ? "—" : state.faceTrigger.armed ? "済" : "未（高止まり中）",
        ],
      ],
    ],
    [
      "写真（この通話）",
      [
        ["発火回数", String(state?.triggerCount ?? 0)],
        ["写真(IndexedDB)", dbCounts == null ? "—" : String(dbCounts.photos)],
        ["音声スニペット", dbCounts == null ? "—" : String(dbCounts.audio)],
        [
          "最終キャプチャ",
          lastCaptureAt == null ? "—" : lastCaptureAt.toTimeString().slice(0, 8),
        ],
      ],
    ],
    [
      "自分側マイク autogain",
      [
        [
          "level",
          autoGain?.enabled && autoGain.measuredDbfs !== null
            ? `${autoGain.measuredDbfs.toFixed(1)} dBFS`
            : "—",
        ],
        [
          "ema",
          autoGain?.enabled && autoGain.emaDbfs !== null
            ? `${autoGain.emaDbfs.toFixed(1)} dBFS`
            : "—",
        ],
        ["gain", autoGain?.enabled ? `+${autoGain.gainDb.toFixed(1)} dB` : "—"],
      ],
    ],
    [
      // 計測ログ（読み取り専用オブザーバー）: 現在の記録件数を小さく表示する。
      "計測ログ",
      [
        ["samples", measurementCounts == null ? "—" : String(measurementCounts.samples)],
        ["events", measurementCounts == null ? "—" : String(measurementCounts.events)],
      ],
    ],
  ];
  return (
    <div data-testid="debug-panel" style={debugPanelStyle}>
      <div style={{ color: "#8f8", fontWeight: 700, marginBottom: 4 }}>
        call debug
      </div>
      {state === null && (
        <div style={{ color: "#aa8", marginBottom: 4 }}>検知未接続…</div>
      )}
      {sections.map(([title, rows]) => (
        <div key={title} style={{ marginBottom: 6 }}>
          <div style={{ color: "#6d6", fontWeight: 700 }}>{title}</div>
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <td style={{ color: "#7c7", paddingRight: 10 }}>{k}</td>
                  <td
                    style={{
                      textAlign: "right",
                      color:
                        k === "busy" && v === "YES"
                          ? "#fd6"
                          : k === "rise" && v.startsWith("+") && !v.startsWith("+—")
                          ? "#6f6"
                          : "#cfc",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {v}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {/* 計測ログの操作ボタン（実地テストで rise/重心比の分布・全発火イベントを後から集計する用）。 */}
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button
          data-testid="measurement-log-download"
          onClick={onMeasurementDownload}
          style={measurementButtonStyle}
        >
          計測ログDL
        </button>
        <button
          data-testid="measurement-log-clear"
          onClick={onMeasurementClear}
          style={measurementButtonStyle}
        >
          ログクリア
        </button>
      </div>
    </div>
  );
}

// 計測ログ操作ボタン（デバッグパネル内・小さめ）。
const measurementButtonStyle: CSSProperties = {
  flex: 1,
  background: "rgba(0,255,0,0.12)",
  color: "#cfc",
  border: "1px solid rgba(0,255,0,0.3)",
  borderRadius: 4,
  fontSize: 10,
  lineHeight: 1.2,
  padding: "4px 6px",
  cursor: "pointer",
};

// デバッグボタン（右下隅・控えめ）。本番公開前に非表示化を判断する（CLAUDE.md 課題）。
const debugToggleStyle: CSSProperties = {
  position: "absolute",
  right: 8,
  bottom: 8,
  zIndex: 21,
  background: "rgba(0,0,0,0.5)",
  color: "rgba(255,255,255,0.6)",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 6,
  fontSize: 10,
  lineHeight: 1.2,
  padding: "3px 8px",
  cursor: "pointer",
};

// 常設「📊ログ」ボタン（左下隅・控えめ）。デバッグトグル（右下）と衝突しない位置。
// NEXT_PUBLIC_MEASUREMENT_UI=1 のときのみ表示。本番公開前に無効化を判断する対象
// （CLAUDE.md「課題（本番前）」参照）。
const measurementQuickButtonStyle: CSSProperties = {
  position: "absolute",
  left: 8,
  bottom: 8,
  zIndex: 21,
  background: "rgba(0,0,0,0.5)",
  color: "rgba(255,255,255,0.6)",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 6,
  fontSize: 10,
  lineHeight: 1.2,
  padding: "3px 8px",
  cursor: "pointer",
};

// 統合デバッグパネル（等幅小フォント・半透明・スクロール可）。
const debugPanelStyle: CSSProperties = {
  position: "absolute",
  right: 8,
  bottom: 36,
  zIndex: 20,
  background: "rgba(0,0,0,0.82)",
  color: "#0f0",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace",
  fontSize: 11,
  lineHeight: 1.35,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid rgba(0,255,0,0.35)",
  minWidth: 200,
  maxWidth: 280,
  maxHeight: "min(62vh, 460px)",
  overflowY: "auto",
  userSelect: "none",
};

// 停止（failed）理由 → バッジに併記する短い括弧書き（詳細は title 属性）。
// reason の文言（facePipeline.ts の failReason）に含まれるキーワードで種別を判定する。
function shortFaceReason(reason: string | null): string {
  if (!reason) return "";
  if (reason.includes("ロード")) return "（読み込み失敗）";
  if (reason.includes("完了しませんでした")) return "（読み込みタイムアウト）";
  if (reason.includes("映像フレーム")) return "（映像未到達）";
  return "";
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
