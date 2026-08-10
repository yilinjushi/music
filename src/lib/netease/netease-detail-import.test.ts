import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMusicStore } from "@/store/music-store";
import { createNeteaseDetailPlaylist } from "./netease-detail-import";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

const track = {
  id: "netease-1",
  name: "Song",
  artist: ["Artist"],
  album: "Album",
  pic_id: "https://p1.music.126.net/song.jpg",
  url_id: "netease-1",
  lyric_id: "netease-1",
  source: "netease" as const,
};

describe("NetEase detail import boundary", () => {
  beforeEach(() => {
    useMusicStore.setState({ playlists: [] });
  });

  it("normalizes a real HTTP/query cover and commits all tracks atomically", () => {
    const id = createNeteaseDetailPlaylist(
      useMusicStore.getState().createPlaylist,
      {
        name: "Real playlist",
        coverImgUrl:
          "http://p1.music.126.net/playlist.jpg?param=300y300#display",
      },
      [track]
    );

    expect(useMusicStore.getState().playlists).toEqual([
      expect.objectContaining({
        id,
        name: "Real playlist",
        coverUrl: "https://p1.music.126.net/playlist.jpg",
        tracks: [expect.objectContaining({ id: "netease-1" })],
      }),
    ]);
  });

  it("leaves no empty playlist when any imported track is unsafe", () => {
    expect(() =>
      createNeteaseDetailPlaylist(
        useMusicStore.getState().createPlaylist,
        { name: "Rejected", coverImgUrl: "" },
        [
          track,
          {
            ...track,
            id: "netease-2",
            url_id: "Bearer%20account-secret-123",
          },
        ]
      )
    ).toThrow(/不安全|无效/);
    expect(useMusicStore.getState().playlists).toEqual([]);
  });
});
