"use client";

// WF-05: アルバム一覧画面（日付＋5枚レイヤー表示・内製）
//
// 既存API制約への対応（backend変更禁止のため既存APIのみで実現）:
// GET /albums のレスポンスには写真一覧（sas_url）が含まれず selected_memory_ids
// （UUID配列）のみを持つ。そこで各アルバムについて GET /calls/{call_id}/candidates
// を追加取得し、selected_memory_ids に一致する candidate から sas_url を引いて
// ベスト5枚のスタック表示に用いる。取得に失敗した場合は動画＋タイトルのみ表示に
// フォールバックする。

import { useEffect, useState } from "react";
import { Album, ApiError, Candidate, getAlbums, getCandidates } from "../../lib/api-client";

interface AlbumWithPhotos {
  album: Album;
  photos: Candidate[]; // selected_memory_ids の順（先頭がベスト1枚）
  photosError: boolean;
}

function formatDateHeading(iso: string | null): string {
  if (!iso) return "日付不明";
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function groupByDate(items: AlbumWithPhotos[]): [string, AlbumWithPhotos[]][] {
  const map = new Map<string, AlbumWithPhotos[]>();
  for (const item of items) {
    const key = formatDateHeading(item.album.confirmed_at);
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
  }
  return Array.from(map.entries());
}

export default function AlbumPage() {
  const [items, setItems] = useState<AlbumWithPhotos[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalPhoto, setModalPhoto] = useState<Candidate | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getAlbums(undefined, 50);
        const withPhotos: AlbumWithPhotos[] = await Promise.all(
          res.items.map(async (album) => {
            if (!album.selected_memory_ids || album.selected_memory_ids.length === 0) {
              return { album, photos: [], photosError: false };
            }
            try {
              const cands = await getCandidates(album.call_id);
              const byId = new Map(cands.candidates.map((c) => [c.id, c]));
              const photos = album.selected_memory_ids
                .map((id) => byId.get(id))
                .filter((c): c is Candidate => !!c);
              return { album, photos, photosError: false };
            } catch {
              // 既存APIの制約または一時的なエラー: 動画＋タイトルのみのフォールバック表示にする。
              return { album, photos: [], photosError: true };
            }
          })
        );
        if (!cancelled) setItems(withPhotos);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : "アルバムの取得に失敗しました");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = groupByDate(items);

  return (
    <div className="family-shell">
      <h1 style={{ fontSize: 20 }}>アルバム</h1>

      {loading && <p>読み込み中…</p>}
      {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}

      {!loading && !error && items.length === 0 && (
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
            {albumsOfDate.map(({ album, photos, photosError }) => (
              <div key={album.id} className="card">
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                  {album.title ?? "ハイライト動画"}
                </div>

                {album.video_sas_url && (
                  <video
                    src={album.video_sas_url}
                    controls
                    style={{ width: "100%", borderRadius: 10, background: "#000", marginBottom: 10 }}
                  />
                )}

                {photosError && (
                  <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                    ※ ベストショットの写真取得に失敗したため動画のみ表示しています
                  </p>
                )}

                {photos.length > 0 && (
                  <div style={{ display: "flex", marginTop: 6, paddingLeft: 4 }}>
                    {photos.map((p, idx) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={p.id}
                        src={p.sas_url}
                        alt={`ベストショット ${idx + 1}`}
                        onClick={() => setModalPhoto(p)}
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
              </div>
            ))}
          </section>
        ))}

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
    </div>
  );
}
