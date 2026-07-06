"use client";

// WF-04: 発信ホーム画面（内製）
// 大きな発信ボタン・新着ハイライトバナー・さいきんのハイライト・アルバムへの導線・
// 相手（高齢者側デバイス）の初回登録リンク発行モーダルを実装する。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Album,
  ApiError,
  createCall,
  getAlbums,
  registerLink,
} from "../lib/api-client";
import { syncPendingCalls } from "../modules/sync";
import FamilyAuthGate from "../components/FamilyAuthGate";
import { getDisplayName, isEntraEnabled, logout } from "../lib/auth";
import {
  googleLogout,
  isGoogleEnabled,
  isGoogleSignedIn,
} from "../lib/googleAuth";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function HomePage() {
  return (
    <FamilyAuthGate>
      <HomePageInner />
    </FamilyAuthGate>
  );
}

function HomePageInner() {
  const router = useRouter();
  const [calling, setCalling] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  // 404 code="no_active_device"（デバイス未登録）のとき true。
  // 「相手の設定」（登録リンク発行）への導線付きでエラーを表示する。
  const [noActiveDevice, setNoActiveDevice] = useState(false);

  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(true);
  const [albumsError, setAlbumsError] = useState<string | null>(null);

  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // サインイン中ユーザーの表示名（ホームに表示＋ログアウト導線）。
  // Google（GIS）はプロフィール名の取得を省き「サインイン中」を出す、Entra は表示名を出す。
  const [displayName, setDisplayName] = useState<string | null>(null);
  // ログアウト導線を出すか（いずれかのプロバイダでサインイン中）。
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isGoogleEnabled() && isGoogleSignedIn()) {
        if (!cancelled) {
          setSignedIn(true);
          setDisplayName("サインイン中");
        }
        return;
      }
      if (isEntraEnabled()) {
        const name = await getDisplayName();
        if (!cancelled) {
          setDisplayName(name);
          setSignedIn(name !== null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ログアウト（プロバイダに応じて破棄）。Google はセッション破棄＋トップ再判定、
  // Entra は MSAL のサインアウト（リダイレクト）。
  function handleLogout() {
    if (isGoogleEnabled() && isGoogleSignedIn()) {
      googleLogout();
      window.location.reload(); // ゲートが未サインインを検出しサインイン画面を出す
      return;
    }
    void logout();
  }

  // 残置分（前回の通話終了時に同期しきれなかった IndexedDB メディア）の自動再同期。
  // 控えめに表示する（成功したらアルバム一覧を再取得する）。
  const [resyncing, setResyncing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { syncedCalls } = await syncPendingCalls();
        if (cancelled) return;
        if (syncedCalls > 0) {
          setResyncing(true);
          try {
            const res = await getAlbums(undefined, 20);
            if (!cancelled) setAlbums(res.items);
          } catch {
            /* 再取得の失敗は無視 */
          } finally {
            if (!cancelled) setResyncing(false);
          }
        }
      } catch {
        /* 残置は保持（次回再試行） */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getAlbums(undefined, 20);
        if (!cancelled) setAlbums(res.items);
      } catch (e) {
        if (!cancelled) {
          setAlbumsError(
            e instanceof ApiError ? e.message : "アルバムの取得に失敗しました"
          );
        }
      } finally {
        if (!cancelled) setAlbumsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCall() {
    // device_id は送らない（v0.4.0・既知課題#5 対応）。
    // サーバが当該家族の active なデバイスへ自動解決する。
    setCalling(true);
    setCallError(null);
    setNoActiveDevice(false);
    try {
      const call = await createCall();
      router.push(`/call?call_id=${call.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.body?.code === "no_active_device") {
        setNoActiveDevice(true);
        setCallError(e.message);
      } else {
        setCallError(e instanceof ApiError ? e.message : "発信に失敗しました");
      }
      setCalling(false);
    }
  }

  async function handleIssueLink() {
    setShowLinkModal(true);
    setLinkLoading(true);
    setLinkError(null);
    setCopied(false);
    try {
      const res = await registerLink();
      setLinkUrl(res.url);
    } catch (e) {
      setLinkError(e instanceof ApiError ? e.message : "リンクの発行に失敗しました");
    } finally {
      setLinkLoading(false);
    }
  }

  async function handleCopy() {
    if (!linkUrl) return;
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  // v0.5.0: GET /albums は全状態（awaiting_selection / generating / ready）を返す。
  // 「さいきんのハイライト」は ready のみ、generating は作成中バナーとして扱う。
  const readyAlbums = albums.filter((a) => a.status === "ready");
  const hasGenerating = albums.some((a) => a.status === "generating");

  // 新着バナー: 最新の ready アルバムが24時間以内に作成（confirmed_at 基準）されたものか
  const latest = readyAlbums[0];
  const showNewBanner =
    !!latest?.confirmed_at &&
    Date.now() - new Date(latest.confirmed_at).getTime() < TWENTY_FOUR_HOURS_MS;

  const highlights = readyAlbums.slice(0, 3);

  return (
    <div className="family-shell">
      {/* いずれかのプロバイダでサインイン中のとき: ユーザー名＋ログアウト（高齢者側には出ない）。 */}
      {signedIn && displayName && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
            fontSize: 13,
            color: "var(--color-text-muted)",
          }}
        >
          <span>{displayName} さん</span>
          <button
            className="link-plain"
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13 }}
            onClick={handleLogout}
          >
            ログアウト
          </button>
        </div>
      )}
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
        元気にしてる？
      </h1>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13, marginTop: 0, marginBottom: 20 }}>
        通話するとAIが感動の瞬間を自動でキャプチャします
      </p>

      {showNewBanner && (
        <div className="banner">
          あたらしい思い出がとどきました（{formatDate(latest.confirmed_at)}）
        </div>
      )}

      {hasGenerating && (
        <a href="/album" style={{ textDecoration: "none", display: "block" }}>
          <div className="banner">
            <span className="spinner" style={{ marginRight: 8 }} />
            思い出を作成中…（アルバムで進み具合が見られます）
          </div>
        </a>
      )}

      {resyncing && (
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 0 }}>
          前回の思い出を同期しています…
        </p>
      )}

      <div className="card" style={{ textAlign: "center" }}>
        <button
          className="btn-primary"
          style={{ fontSize: 22, padding: 28 }}
          onClick={handleCall}
          disabled={calling}
        >
          {calling ? "発信中…" : "📞 母に電話"}
        </button>
        {callError && (
          <p style={{ color: "var(--color-danger)", fontSize: 13, marginTop: 10 }}>
            {callError}
          </p>
        )}
        {noActiveDevice && (
          <button
            className="btn-secondary"
            style={{ marginTop: 8 }}
            onClick={handleIssueLink}
          >
            相手の設定から登録する
          </button>
        )}
      </div>

      <section className="card">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>さいきんのハイライト</h2>
        {albumsLoading && <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>読み込み中…</p>}
        {albumsError && (
          <p style={{ fontSize: 13, color: "var(--color-danger)" }}>{albumsError}</p>
        )}
        {!albumsLoading && !albumsError && highlights.length === 0 && (
          <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
            まだ思い出はありません。母に電話して、最初の思い出をつくりましょう。
          </p>
        )}
        {!albumsLoading && highlights.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* 個別アルバムへの遷移（既知課題#3 解消）: /album?highlight=<album_id> で
                該当カードへスクロール＋一時ハイライト */}
            {highlights.map((a) => (
              <a
                key={a.id}
                href={`/album?highlight=${a.id}`}
                style={{
                  border: "1px solid var(--color-border)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  textDecoration: "none",
                  display: "block",
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 14 }}>
                  {a.title ?? "ハイライト動画"}
                </div>
                <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                  {formatDate(a.confirmed_at)}
                  <span style={{ marginLeft: 8, color: "var(--color-accent)" }}>見る ＞</span>
                </div>
              </a>
            ))}
          </div>
        )}
        <a className="link-plain" href="/album" style={{ display: "inline-block", marginTop: 12 }}>
          アルバムを見る ＞
        </a>
      </section>

      <div style={{ textAlign: "center", marginTop: 8 }}>
        <button className="link-plain" style={{ background: "none", border: "none", cursor: "pointer" }} onClick={handleIssueLink}>
          相手の設定
        </button>
      </div>

      {showLinkModal && (
        <div className="modal-overlay" onClick={() => setShowLinkModal(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>高齢者側デバイスの登録リンク</h3>
            {linkLoading && <p>発行中…</p>}
            {linkError && <p style={{ color: "var(--color-danger)" }}>{linkError}</p>}
            {linkUrl && (
              <>
                <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
                  このURLを高齢者側の端末（Chrome）で開いてもらうと、登録が完了します。
                  一度きり有効です。
                </p>
                <div
                  style={{
                    wordBreak: "break-all",
                    background: "var(--color-bg)",
                    borderRadius: 8,
                    padding: 10,
                    fontSize: 12,
                    marginBottom: 12,
                  }}
                >
                  {linkUrl}
                </div>
                <button className="btn-primary" onClick={handleCopy}>
                  {copied ? "コピーしました" : "URLをコピー"}
                </button>
              </>
            )}
            <button
              className="btn-secondary"
              style={{ marginTop: 10 }}
              onClick={() => setShowLinkModal(false)}
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
