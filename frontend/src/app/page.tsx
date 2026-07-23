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
  getDevices,
  getMe,
  registerLink,
  updateDeviceDisplayName,
  updateMyDisplayName,
} from "../lib/api-client";
import { syncPendingCalls } from "../modules/sync";
import FamilyAuthGate from "../components/FamilyAuthGate";
import { getDisplayName, isEntraEnabled, logout } from "../lib/auth";
import {
  googleLogout,
  isGoogleEnabled,
  isGoogleSignedIn,
} from "../lib/googleAuth";
import {
  deleteMeasurementLog,
  getMeasurementLog,
  listMeasurementLogs,
  type MeasurementLogSummary,
} from "../modules/detection/measurementLogStorage";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 計測ログ一覧の日時表示（月/日 時:分）。
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

  // 相手（高齢者側デバイス）の表示名設定（タスクB・Zoom風ラベル用）。
  // 名前入力欄は owner 前提の UI（サインインで作られる家族ユーザーは全員 owner）。
  // 非 owner の場合も backend の PATCH が 403 を返す最終ガードで防ぐ。
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameFeedback, setNameFeedback] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  // 自分（家族メンバー自身）の表示名設定（機能A・v0.7.0）。
  // TV側の着信・通話ラベル（caller_display_name）や自分小窓ラベルに使う。
  // owner / viewer とも自分の名前は設定できる（backend は本人限定）。
  const [showSelfModal, setShowSelfModal] = useState(false);
  const [selfNameInput, setSelfNameInput] = useState("");
  const [selfNameSaving, setSelfNameSaving] = useState(false);
  const [selfNameFeedback, setSelfNameFeedback] = useState<string | null>(null);
  const [selfNameError, setSelfNameError] = useState<string | null>(null);

  // 計測ログ（トリガーテスト用・通話終了後の回収導線）: NEXT_PUBLIC_MEASUREMENT_UI=1 のときのみ表示。
  const measurementUiEnabled = process.env.NEXT_PUBLIC_MEASUREMENT_UI === "1";
  const [measurementLogs, setMeasurementLogs] = useState<MeasurementLogSummary[]>([]);
  const [measurementLogsLoading, setMeasurementLogsLoading] = useState(true);
  const [measurementLogsError, setMeasurementLogsError] = useState<string | null>(null);

  // 計測ログ一覧を読み込む（初回＋削除後の再読込で使う）。
  async function loadMeasurementLogs(): Promise<void> {
    try {
      const items = await listMeasurementLogs();
      setMeasurementLogs(items);
      setMeasurementLogsError(null);
    } catch (e) {
      setMeasurementLogsError(
        e instanceof Error ? e.message : "計測ログの取得に失敗しました"
      );
    } finally {
      setMeasurementLogsLoading(false);
    }
  }

  useEffect(() => {
    if (!measurementUiEnabled) {
      setMeasurementLogsLoading(false);
      return;
    }
    void loadMeasurementLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 「DL」: 指定 call_id の保存済み計測ログJSONをダウンロードする
  // （通話画面の計測ログDLと同じ Blob+a.download パターン）。
  async function handleMeasurementLogDownload(callId: string): Promise<void> {
    try {
      const rec = await getMeasurementLog(callId);
      if (!rec) return;
      const json = JSON.stringify(rec.data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `measurement-log-${callId}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      /* ダウンロード失敗は無視（一覧はそのまま残す） */
    }
  }

  // 「削除」: 指定 call_id の計測ログを削除し一覧を再読込する。
  async function handleMeasurementLogDelete(callId: string): Promise<void> {
    try {
      await deleteMeasurementLog(callId);
      await loadMeasurementLogs();
    } catch {
      /* 削除失敗は無視（次回操作で再試行可能） */
    }
  }

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

  // 「相手の設定」を開く。登録リンクを発行しつつ、現在のデバイス表示名を読み込む。
  function handleOpenSettings() {
    setShowLinkModal(true);
    setNameFeedback(null);
    setNameError(null);
    void handleIssueLink();
    void loadDeviceName();
  }

  async function handleIssueLink() {
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

  // 現在のデバイス表示名を取得して入力欄に初期表示する（1件想定・先頭を採用）。
  async function loadDeviceName() {
    try {
      const res = await getDevices();
      const device = res.items[0] ?? null;
      setDeviceId(device?.device_id ?? null);
      setNameInput(device?.display_name ?? "");
    } catch {
      // 取得失敗時は名前欄を空のままにする（保存はデバイス未取得なら不可）。
      setDeviceId(null);
    }
  }

  // 相手の名前を保存する（owner のみ。backend が 403 で最終ガード）。
  async function handleSaveName() {
    if (!deviceId) {
      setNameError("先にデバイスを登録してください");
      return;
    }
    setNameSaving(true);
    setNameFeedback(null);
    setNameError(null);
    try {
      const trimmed = nameInput.trim();
      const updated = await updateDeviceDisplayName(deviceId, trimmed ? trimmed : null);
      setNameInput(updated.display_name ?? "");
      setNameFeedback(
        updated.display_name
          ? `「${updated.display_name}」に設定しました`
          : "名前を未設定にしました"
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setNameError("名前の変更は owner のみ行えます");
      } else {
        setNameError(e instanceof ApiError ? e.message : "名前の保存に失敗しました");
      }
    } finally {
      setNameSaving(false);
    }
  }

  // 「自分の設定」を開く。現在の自分の表示名を読み込んで入力欄に初期表示する。
  function handleOpenSelfSettings() {
    setShowSelfModal(true);
    setSelfNameFeedback(null);
    setSelfNameError(null);
    void loadSelfName();
  }

  // 現在の自分の表示名を取得して入力欄に初期表示する（GET /users/me）。
  async function loadSelfName() {
    try {
      const me = await getMe();
      setSelfNameInput(me.display_name ?? "");
    } catch {
      // 取得失敗時は空のままにする（保存は可能＝新規設定として動く）。
      setSelfNameInput("");
    }
  }

  // 自分の名前を保存する（本人のみ・owner/viewer とも設定可）。
  async function handleSaveSelfName() {
    setSelfNameSaving(true);
    setSelfNameFeedback(null);
    setSelfNameError(null);
    try {
      const trimmed = selfNameInput.trim();
      const updated = await updateMyDisplayName(trimmed ? trimmed : null);
      setSelfNameInput(updated.display_name ?? "");
      setSelfNameFeedback(
        updated.display_name
          ? `「${updated.display_name}」に設定しました`
          : "名前を未設定にしました"
      );
    } catch (e) {
      setSelfNameError(
        e instanceof ApiError ? e.message : "名前の保存に失敗しました"
      );
    } finally {
      setSelfNameSaving(false);
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
            onClick={handleOpenSettings}
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

      {/* 計測ログ（トリガーテスト用・通話終了後の回収導線）: NEXT_PUBLIC_MEASUREMENT_UI=1 のみ表示。 */}
      {measurementUiEnabled && (
        <section className="card" data-testid="measurement-log-section">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>計測ログ（トリガーテスト用）</h2>
          {measurementLogsLoading && (
            <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>読み込み中…</p>
          )}
          {measurementLogsError && (
            <p style={{ fontSize: 13, color: "var(--color-danger)" }}>{measurementLogsError}</p>
          )}
          {!measurementLogsLoading && !measurementLogsError && measurementLogs.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
              保存済みの計測ログはありません（通話中は約10秒ごと・通話終了時に自動保存されます）。
            </p>
          )}
          {!measurementLogsLoading && measurementLogs.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {measurementLogs.map((log) => (
                <div
                  key={log.callId}
                  data-testid="measurement-log-row"
                  style={{
                    border: "1px solid var(--color-border)",
                    borderRadius: 10,
                    padding: "10px 12px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>
                      {formatDateTime(log.updatedAt)}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--color-text-muted)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      call_id: {log.callId}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                      samples: {log.samples} / events: {log.events}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                      className="btn-secondary"
                      data-testid="measurement-log-row-download"
                      style={{ fontSize: 12, padding: "6px 10px" }}
                      onClick={() => void handleMeasurementLogDownload(log.callId)}
                    >
                      DL
                    </button>
                    <button
                      className="btn-secondary"
                      data-testid="measurement-log-row-delete"
                      style={{ fontSize: 12, padding: "6px 10px" }}
                      onClick={() => void handleMeasurementLogDelete(log.callId)}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 20,
          marginTop: 8,
        }}
      >
        <button
          className="link-plain"
          data-testid="open-self-settings"
          style={{ background: "none", border: "none", cursor: "pointer" }}
          onClick={handleOpenSelfSettings}
        >
          自分の設定
        </button>
        <button className="link-plain" style={{ background: "none", border: "none", cursor: "pointer" }} onClick={handleOpenSettings}>
          相手の設定
        </button>
      </div>

      {showSelfModal && (
        <div className="modal-overlay" onClick={() => setShowSelfModal(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>自分の名前</h3>
            <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 0 }}>
              通話中に相手（TV側）へ表示される、あなたの名前です（例:「たろう」）。
              未入力にすると表示されません。
            </p>
            <input
              type="text"
              value={selfNameInput}
              maxLength={30}
              placeholder="たろう"
              onChange={(e) => setSelfNameInput(e.target.value)}
              data-testid="self-name-input"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "8px 10px",
                fontSize: 14,
                borderRadius: 8,
                border: "1px solid var(--color-border)",
                marginBottom: 8,
              }}
            />
            {selfNameFeedback && (
              <p style={{ fontSize: 13, color: "var(--color-success, #2e7d32)", margin: "0 0 8px" }}>
                {selfNameFeedback}
              </p>
            )}
            {selfNameError && (
              <p style={{ fontSize: 13, color: "var(--color-danger)", margin: "0 0 8px" }}>
                {selfNameError}
              </p>
            )}
            <button
              className="btn-primary"
              data-testid="self-name-save"
              disabled={selfNameSaving}
              onClick={() => void handleSaveSelfName()}
            >
              {selfNameSaving ? "保存中…" : "名前を保存"}
            </button>
            <button
              className="btn-secondary"
              style={{ marginTop: 10 }}
              onClick={() => setShowSelfModal(false)}
            >
              閉じる
            </button>
          </div>
        </div>
      )}

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

            {/* 相手の名前（通話画面の左下ラベルに表示・タスクB）。owner 前提の UI。 */}
            <div
              style={{
                marginTop: 18,
                paddingTop: 14,
                borderTop: "1px solid var(--color-border)",
              }}
            >
              <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>相手の名前</h3>
              <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 0 }}>
                通話画面に表示される名前です（例:「おばあちゃん」）。未入力にすると表示されません。
              </p>
              <input
                type="text"
                value={nameInput}
                maxLength={30}
                placeholder="おばあちゃん"
                onChange={(e) => setNameInput(e.target.value)}
                data-testid="device-name-input"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 10px",
                  fontSize: 14,
                  borderRadius: 8,
                  border: "1px solid var(--color-border)",
                  marginBottom: 8,
                }}
              />
              {nameFeedback && (
                <p style={{ fontSize: 13, color: "var(--color-success, #2e7d32)", margin: "0 0 8px" }}>
                  {nameFeedback}
                </p>
              )}
              {nameError && (
                <p style={{ fontSize: 13, color: "var(--color-danger)", margin: "0 0 8px" }}>
                  {nameError}
                </p>
              )}
              <button
                className="btn-primary"
                data-testid="device-name-save"
                disabled={nameSaving}
                onClick={() => void handleSaveName()}
              >
                {nameSaving ? "保存中…" : "名前を保存"}
              </button>
            </div>

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
