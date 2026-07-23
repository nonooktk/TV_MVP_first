// 待受アルバム自動ループ再生の純粋ロジック（nextOnPoll / recoverOnError）の単体テスト（B-2）。
//
// - nextOnPoll: 60秒ごとの定期確認での差し替え判定。
//   同一 id/version は null（src を触らずループ維持）、id か version の変化で新再生対象を返す、
//   取得不可（null）・動画なし（video_sas_url なし）は null（現在の再生を維持）。
// - recoverOnError: onError 時の再取得。SAS が変わるため識別子同一でも常に新しい再生対象を返す。

import { describe, expect, it } from "vitest";

import {
  nextOnPoll,
  recoverOnError,
  type AlbumIdentity,
} from "../src/modules/standbyAlbum";
import type { Album } from "../src/lib/api-client";

// テスト用 Album を最小構成で作る（B-2 が参照するのは id / version / video_sas_url のみ）。
function makeAlbum(overrides: Partial<Album>): Album {
  return {
    id: "album-1",
    call_id: "call-1",
    status: "ready",
    selected_memory_ids: null,
    title: null,
    caption: null,
    bgm_track: null,
    video_storage_key: "families/f/calls/c/albums/v1.mp4",
    video_sas_url: "https://blob/v1.mp4?sig=AAA",
    collage_sas_url: null,
    version: 1,
    presented_at: null,
    confirmed_at: null,
    auto_confirmed: false,
    photos: null,
    ...overrides,
  };
}

describe("nextOnPoll（定期確認の差し替え判定）", () => {
  it("初回（current=null）は取得したアルバムを再生対象として返す", () => {
    const album = makeAlbum({ id: "a1", version: 1 });
    const next = nextOnPoll(null, album);
    expect(next).toEqual({
      id: "a1",
      version: 1,
      videoUrl: album.video_sas_url,
    });
  });

  it("同一 id/version は null（src を触らずループを維持）＝SAS が変わっても差し替えない", () => {
    const current: AlbumIdentity = { id: "a1", version: 2 };
    // 同じ id/version だが SAS 署名だけ変わったアルバム（再ポーリングで sig が変わる想定）。
    const album = makeAlbum({
      id: "a1",
      version: 2,
      video_sas_url: "https://blob/v2.mp4?sig=DIFFERENT",
    });
    expect(nextOnPoll(current, album)).toBeNull();
  });

  it("version が上がったら差し替える（動画再生成＝version 増加）", () => {
    const current: AlbumIdentity = { id: "a1", version: 2 };
    const album = makeAlbum({
      id: "a1",
      version: 3,
      video_sas_url: "https://blob/v3.mp4?sig=BBB",
    });
    const next = nextOnPoll(current, album);
    expect(next).toEqual({
      id: "a1",
      version: 3,
      videoUrl: "https://blob/v3.mp4?sig=BBB",
    });
  });

  it("id が変わったら差し替える（別通話の新しいアルバム）", () => {
    const current: AlbumIdentity = { id: "a1", version: 5 };
    const album = makeAlbum({ id: "a2", version: 1 });
    const next = nextOnPoll(current, album);
    expect(next?.id).toBe("a2");
    expect(next?.version).toBe(1);
  });

  it("取得できなかった（null）ときは差し替えない（現在の再生を維持）", () => {
    const current: AlbumIdentity = { id: "a1", version: 1 };
    expect(nextOnPoll(current, null)).toBeNull();
  });

  it("video_sas_url が無い（動画未生成）ときは差し替えない", () => {
    const current: AlbumIdentity = { id: "a1", version: 1 };
    const album = makeAlbum({ id: "a9", version: 1, video_sas_url: null });
    expect(nextOnPoll(current, album)).toBeNull();
  });

  it("初期状態（current=null）で動画未生成なら null（何も表示しない）", () => {
    const album = makeAlbum({ video_sas_url: null });
    expect(nextOnPoll(null, album)).toBeNull();
  });
});

describe("recoverOnError（onError 時の再取得）", () => {
  it("識別子が同一でも新しい SAS で張り直す（SAS 期限切れからの復帰）", () => {
    const album = makeAlbum({
      id: "a1",
      version: 2,
      video_sas_url: "https://blob/v2.mp4?sig=FRESH",
    });
    const next = recoverOnError(album);
    expect(next).toEqual({
      id: "a1",
      version: 2,
      videoUrl: "https://blob/v2.mp4?sig=FRESH",
    });
  });

  it("取得できない（null）ときは null（復帰しない）", () => {
    expect(recoverOnError(null)).toBeNull();
  });

  it("動画が無いときは null（復帰しない）", () => {
    const album = makeAlbum({ video_sas_url: null });
    expect(recoverOnError(album)).toBeNull();
  });
});
