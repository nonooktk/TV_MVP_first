"use client";

// WF-05: アルバム一覧画面（日付＋5枚レイヤー表示・内製）
//
// v0.5.0（フィードバック改善 第2段）で新 GET /albums に全面移行:
// - レスポンスの photos（確定5枚・thumb_sas_url/sas_url）を直接使う
//   （旧実装の GET /calls/{call_id}/candidates 突合＝N+1 は撤去。API 呼び出しは 1 回）
// - status 別カード: awaiting_selection（選択待ち・選択ページへの導線）/
//   generating（作成中スピナー・5秒ポーリングで ready へ自動切替）/
//   ready（動画｜コラージュのタブ切替＋5枚サムネスタック＋削除ボタン）
// - サムネは components/ThumbImage で thumb_sas_url → sas_url フォールバック
// - ?highlight=<album_id> でホームから遷移した個別アルバムへスクロール＋一時ハイライト

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import {
  Album,
  AlbumPhoto,
  ApiError,
  deleteAlbum,
  getAlbums,
} from "../../lib/api-client";
import BackHeader from "../../components/BackHeader";
import ThumbImage from "../../components/ThumbImage";

const POLL_INTERVAL_MS = 5000; // generating があるときの一覧ポーリング間隔

function formatDateHeading(iso: string | null): string {
  if (!iso) return "日付不明";
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** アルバムの見出し日付（ready は confirmed_at、それ以外は presented_at を優先） */
function albumDateKey(album: Album): string {
  return formatDateHeading(album.confirmed_at ?? album.presented_at);
}

function groupByDate(items: Album[]): [string, Album[]][] {
  const map = new Map<string, Album[]>();
  for (const album of items) {
    const key = albumDateKey(album);
    const arr = map.get(key) ?? [];
    arr.push(album);
    map.set(key, arr);
  }
  return Array.from(map.entries());
}

export default function AlbumPage() {
  // useSearchParams() は Suspense boundary 配下でのみ使用できるため分離する。
  return (
    <Suspense fallback={<div className="family-shell" />}>
      <AlbumPageInner />
    </Suspense>
  );
}

function AlbumPageInner() {
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("highlight");

  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalPhoto, setModalPhoto] = useState<AlbumPhoto | null>(null);
  const [modalCollage, setModalCollage] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Album | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const highlightDone = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await getAlbums(undefined, 50);
      setAlbums(res.items);
      setError(null);
    } catch (e) {
      // ポーリング中（silent）の一過性エラーは表示を壊さない。
      if (!silent) {
        setError(e instanceof ApiError ? e.message : "アルバムの取得に失敗しました");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // generating が1件でもあれば5秒間隔でポーリングし、ready への切替を自動反映する。
  const hasGenerating = albums.some((a) => a.status === "generating");
  useEffect(() => {
    if (!hasGenerating) return;
    const timer = setInterval(() => load(true), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasGenerating, load]);

  // ?highlight=<album_id>: 初回ロード後に該当カードへスクロール＋一時ハイライト。
  useEffect(() => {
    if (loading || !highlightId || highlightDone.current) return;
    const el = document.getElementById(`album-${highlightId}`);
    if (el) {
      highlightDone.current = true;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [loading, highlightId, albums]);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAlbum(deleteTarget.id);
      // 一覧から除去（ローカル更新。次回ポーリング/再訪でも整合する）。
      setAlbums((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (e) {
      setDeleteError(
        e instanceof ApiError ? e.message : "削除に失敗しました。もう一度お試しください"
      );
    } finally {
      setDeleting(false);
    }
  }

  const grouped = groupByDate(albums);

  return (
    <div className="family-shell">
      <BackHeader />
      <h1 style={{ fontSize: 20 }}>アルバム</h1>

      {loading && <p>読み込み中…</p>}
      {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}

      {!loading && !error && albums.length === 0 && (
        <div className="card" style={{ textAlign: "center" }}>
          <p>まだ思い出はありません</p>
          <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
            母に電話して、最初の思い出をつくろう
          </p>
          <a href="/" className="btn-primary" style={{ display: "inline-flex", textDecoration: "none", marginTop: 8 }}>
            母に電話
          </a>
        </div>
      )}

      {!loading &&
        grouped.map(([dateLabel, albumsOfDate]) => (
          <section key={dateLabel} style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 15, color: "var(--color-text-muted)", marginBottom: 8 }}>
              {dateLabel}
            </h2>
            {albumsOfDate.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                highlighted={album.id === highlightId}
                onPhotoClick={setModalPhoto}
                onCollageClick={setModalCollage}
                onDeleteClick={() => {
                  setDeleteError(null);
                  setDeleteTarget(album);
                }}
              />
            ))}
          </section>
        ))}

      {/* 写真タップ拡大（原寸 sas_url を表示） */}
      {modalPhoto && (
        <div className="modal-overlay" onClick={() => setModalPhoto(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ padding: 8 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={modalPhoto.sas_url}
              alt="拡大表示"
              style={{ width: "100%", borderRadius: 8, display: "block" }}
            />
            <button className="btn-secondary" style={{ marginTop: 10 }} onClick={() => setModalPhoto(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* コラージュタップ拡大 */}
      {modalCollage && (
        <div className="modal-overlay" onClick={() => setModalCollage(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ padding: 8 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={modalCollage}
              alt="コラージュ拡大表示"
              style={{ width: "100%", borderRadius: 8, display: "block" }}
            />
            <button className="btn-secondary" style={{ marginTop: 10 }} onClick={() => setModalCollage(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* 削除確認ダイアログ */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>このアルバムを削除しますか？</h3>
            <p style={{ fontSize: 14 }}>
              動画・コラージュ・選ばれた5枚の写真も完全に削除され、元に戻せません
            </p>
            {deleteError && (
              <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{deleteError}</p>
            )}
            <button
              className="btn-primary"
              style={{ background: "var(--color-danger)" }}
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? "削除中…" : "削除する"}
            </button>
            <button
              className="btn-secondary"
              style={{ marginTop: 10 }}
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- 状態別カード ------------------------------------------------------------

interface AlbumCardProps {
  album: Album;
  highlighted: boolean;
  onPhotoClick: (photo: AlbumPhoto) => void;
  onCollageClick: (url: string) => void;
  onDeleteClick: () => void;
}

function AlbumCard({
  album,
  highlighted,
  onPhotoClick,
  onCollageClick,
  onDeleteClick,
}: AlbumCardProps) {
  return (
    <div
      id={`album-${album.id}`}
      className={`card${highlighted ? " card-highlight" : ""}`}
      data-album-status={album.status}
    >
      {album.status === "awaiting_selection" && (
        <>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>ベストショットの選択待ち</div>
          <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 0 }}>
            通話中の写真から、思い出にする5枚を選んでください。
          </p>
          <a
            className="btn-primary"
            href={`/select?call_id=${album.call_id}`}
            style={{ textDecoration: "none" }}
          >
            ベストショットを選ぶ
          </a>
        </>
      )}

      {album.status === "generating" && (
        <>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            <span className="spinner" style={{ marginRight: 8 }} />
            思い出のムービーを作成中…
          </div>
          <p style={{ fontSize: 13, color: "var(--color-text-muted)", margin: 0 }}>
            目安30秒〜1分。できあがると自動でここに表示されます。
          </p>
        </>
      )}

      {album.status === "ready" && (
        <ReadyAlbumBody
          album={album}
          onPhotoClick={onPhotoClick}
          onCollageClick={onCollageClick}
          onDeleteClick={onDeleteClick}
        />
      )}
    </div>
  );
}

function ReadyAlbumBody({
  album,
  onPhotoClick,
  onCollageClick,
  onDeleteClick,
}: Omit<AlbumCardProps, "highlighted">) {
  const [tab, setTab] = useState<"video" | "collage">("video");
  const photos = album.photos ?? [];
  const hasCollage = !!album.collage_sas_url;

  return (
    <>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>
        {album.title ?? "ハイライト動画"}
      </div>

      {/* コラージュがあるときだけタブを出す（collage_sas_url が null ならタブ非表示＝動画のみ） */}
      {hasCollage && (
        <div className="tab-bar" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "video"}
            className={`tab-btn${tab === "video" ? " active" : ""}`}
            onClick={() => setTab("video")}
          >
            動画
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "collage"}
            className={`tab-btn${tab === "collage" ? " active" : ""}`}
            onClick={() => setTab("collage")}
          >
            コラージュ
          </button>
        </div>
      )}

      {(!hasCollage || tab === "video") && album.video_sas_url && (
        <video
          src={album.video_sas_url}
          controls
          style={{ width: "100%", borderRadius: 10, background: "#000", marginBottom: 10 }}
        />
      )}

      {hasCollage && tab === "collage" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={album.collage_sas_url!}
          alt="思い出のコラージュ"
          loading="lazy"
          onClick={() => onCollageClick(album.collage_sas_url!)}
          style={{
            width: "100%",
            borderRadius: 10,
            marginBottom: 10,
            cursor: "pointer",
            display: "block",
          }}
        />
      )}

      {photos.length > 0 && (
        <div style={{ display: "flex", marginTop: 6, paddingLeft: 4 }}>
          {photos.map((p, idx) => (
            <ThumbImage
              key={p.memory_id}
              thumbSrc={p.thumb_sas_url}
              fallbackSrc={p.sas_url}
              alt={`ベストショット ${idx + 1}`}
              onClick={() => onPhotoClick(p)}
              style={{
                width: 64,
                height: 64,
                objectFit: "cover",
                borderRadius: 8,
                border: "2px solid #fff",
                boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
                marginLeft: idx === 0 ? 0 : -20,
                zIndex: photos.length - idx,
                cursor: "pointer",
                position: "relative",
              }}
            />
          ))}
        </div>
      )}

      <div style={{ textAlign: "right", marginTop: 10 }}>
        <button
          type="button"
          onClick={onDeleteClick}
          style={{
            background: "none",
            border: "none",
            color: "var(--color-danger)",
            fontSize: 13,
            cursor: "pointer",
            padding: 4,
          }}
        >
          このアルバムを削除
        </button>
      </div>
    </>
  );
}
