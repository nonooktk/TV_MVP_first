"use client";

// ベストショット選択画面（内製）
// GET /calls/{call_id}/candidates で候補一覧を取得し、5枚選択→確定する。
// auto_confirm_at から自動確定までの残り時間をカウントダウン表示する。
//
// v0.5.0（フィードバック改善 第2段）:
// - 候補グリッドは thumb_sas_url（幅320pxサムネ）を表示（未生成時は sas_url へ
//   フォールバック＝components/ThumbImage）
// - 確定後はアルバムページへ遷移する（生成中カードが見える。?highlight=<album_id>）

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiError, Candidate, getCandidates, submitSelection } from "../../lib/api-client";
import BackHeader from "../../components/BackHeader";
import ThumbImage from "../../components/ThumbImage";

const REQUIRED_COUNT = 5;

function formatCountdown(ms: number): string {
  if (ms <= 0) return "まもなく自動確定";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `残り ${min}分${sec.toString().padStart(2, "0")}秒`;
}

export default function SelectPage() {
  // useSearchParams() は Suspense boundary 配下でのみ使用できるため分離する。
  return (
    <Suspense fallback={<div className="family-shell" />}>
      <SelectPageInner />
    </Suspense>
  );
}

function SelectPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callId = searchParams.get("call_id");

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [autoConfirmAt, setAutoConfirmAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState<"generating" | "not_found" | "other" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [confirmedAlbumId, setConfirmedAlbumId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!callId) return;
    setLoading(true);
    setErrorState(null);
    setErrorMessage(null);
    try {
      const res = await getCandidates(callId);
      setCandidates(res.candidates);
      setAlbumId(res.album_id);
      setAutoConfirmAt(res.auto_confirm_at);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErrorState("generating");
        setErrorMessage(e.message);
      } else if (e instanceof ApiError && e.status === 404) {
        setErrorState("not_found");
        setErrorMessage("候補を準備中です");
      } else {
        setErrorState("other");
        setErrorMessage(e instanceof ApiError ? e.message : "候補の取得に失敗しました");
      }
    } finally {
      setLoading(false);
    }
  }, [callId]);

  useEffect(() => {
    load();
  }, [load]);

  // カウントダウン更新（1秒ごと）
  useEffect(() => {
    if (!autoConfirmAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [autoConfirmAt]);

  const remainingMs = useMemo(() => {
    if (!autoConfirmAt) return null;
    return new Date(autoConfirmAt).getTime() - now;
  }, [autoConfirmAt, now]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((x) => x !== id);
      }
      if (prev.length >= REQUIRED_COUNT) {
        return prev; // 5枚を超える選択は無視
      }
      return [...prev, id];
    });
  }

  async function handleConfirm() {
    if (!callId || selectedIds.length !== REQUIRED_COUNT) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const album = await submitSelection(callId, selectedIds);
      setConfirmedAlbumId(album.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErrorState("generating");
        setErrorMessage(e.message);
      } else {
        setErrorMessage(e instanceof ApiError ? e.message : "確定に失敗しました");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!callId) {
    return (
      <div className="family-shell">
        <p>call_id が指定されていません。</p>
      </div>
    );
  }

  if (confirmedAlbumId) {
    return (
      <div className="family-shell" style={{ textAlign: "center" }}>
        <div className="card">
          <h2>選択を確定しました</h2>
          <p style={{ fontSize: 14, color: "var(--color-text-muted)" }}>
            思い出のムービーを作成しています。アルバムページで生成状況を確認できます。
          </p>
          <button
            className="btn-primary"
            onClick={() => router.push(`/album?highlight=${confirmedAlbumId}`)}
          >
            アルバムを見る（作成中の様子が見えます）
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="family-shell">
      <BackHeader />
      <h1 style={{ fontSize: 20 }}>ベストショットを5枚選ぶ</h1>

      {loading && <p>読み込み中…</p>}

      {!loading && errorState === "generating" && (
        <div className="card">
          <p>この通話にはまだ候補がありません。生成中です。</p>
          <button className="btn-secondary" onClick={load}>再読み込み</button>
        </div>
      )}

      {!loading && errorState === "not_found" && (
        <div className="card">
          <p>候補を準備中です。しばらくしてからもう一度お試しください。</p>
          <button className="btn-secondary" onClick={load}>再読み込み</button>
        </div>
      )}

      {!loading && errorState === "other" && (
        <div className="card">
          <p style={{ color: "var(--color-danger)" }}>{errorMessage}</p>
          <button className="btn-secondary" onClick={load}>再読み込み</button>
        </div>
      )}

      {!loading && !errorState && candidates.length > 0 && (
        <>
          <div className="card" style={{ textAlign: "center" }}>
            <div style={{ fontSize: 14 }}>
              選択 {selectedIds.length} / {REQUIRED_COUNT} 枚
            </div>
            {remainingMs !== null && (
              <div
                style={{
                  fontSize: 13,
                  color: remainingMs < 60000 ? "var(--color-danger)" : "var(--color-text-muted)",
                  marginTop: 4,
                }}
              >
                自動確定まで {formatCountdown(remainingMs)}
              </div>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              marginBottom: 16,
            }}
          >
            {candidates.map((c) => {
              const order = selectedIds.indexOf(c.id);
              const isSelected = order !== -1;
              return (
                <div
                  key={c.id}
                  onClick={() => toggleSelect(c.id)}
                  style={{
                    position: "relative",
                    borderRadius: 12,
                    overflow: "hidden",
                    border: isSelected
                      ? "3px solid var(--color-primary)"
                      : "1px solid var(--color-border)",
                    cursor: "pointer",
                    background: "#eee",
                  }}
                >
                  <ThumbImage
                    thumbSrc={c.thumb_sas_url}
                    fallbackSrc={c.sas_url}
                    alt={`候補 rank ${c.rank}`}
                    style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block" }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      top: 6,
                      left: 6,
                      background: "rgba(0,0,0,0.6)",
                      color: "#fff",
                      fontSize: 11,
                      padding: "2px 6px",
                      borderRadius: 6,
                    }}
                  >
                    rank {c.rank}
                    {c.score !== null ? ` / score ${c.score.toFixed(2)}` : ""}
                  </div>
                  {isSelected && (
                    <div
                      style={{
                        position: "absolute",
                        top: 6,
                        right: 6,
                        width: 26,
                        height: 26,
                        borderRadius: "50%",
                        background: "var(--color-primary)",
                        color: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: 700,
                        fontSize: 13,
                      }}
                    >
                      {order + 1}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {errorMessage && (
            <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{errorMessage}</p>
          )}

          <button
            className="btn-primary"
            disabled={selectedIds.length !== REQUIRED_COUNT || submitting}
            onClick={handleConfirm}
          >
            {submitting ? "確定中…" : "これで確定"}
          </button>
        </>
      )}
    </div>
  );
}
