import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("@/lib/api/config", () => ({
  getApiUrl: () => "https://app.example",
  getProxyUrl: (url: string) =>
    `https://app.example/proxy?url=${encodeURIComponent(url)}`,
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));

import {
  getMiguLyric,
  getMiguSongUrl,
  parseMiguPlaylistUrl,
  searchMiguSongs,
} from "./migu-api";
import {
  convertMiguSongToMusicTrack,
  fetchMiguPlaylistDetail,
} from "@otter-music/shared";
import { normalizeAudioUrlForPlayback } from "@/lib/utils/audio-url";
import { sanitizeTrackForPersistence } from "@/lib/utils/sensitive-data";

describe("Migu browser BFF client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses public playlist links", () => {
    expect(
      parseMiguPlaylistUrl("https://music.migu.cn/v3/music/playlist/12345")
    ).toBe("12345");
  });

  it("constructs a normalizer-safe opaque playback URL", async () => {
    const url = await getMiguSongUrl("migu_copyright_content", 320);
    expect(url).toBe(
      "/music-api/migu/audio?copyrightId=copyright&contentId=content&br=320"
    );
    expect(url).not.toMatch(/key|tim|signature/i);
    expect(normalizeAudioUrlForPlayback(url || "")).toBe(url);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searches only through the BFF", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ items: [], hasMore: false }))
    );
    await expect(searchMiguSongs("test", 1)).resolves.toEqual({
      items: [],
      hasMore: false,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://app.example/music-api/migu/search"
    );
  });

  it("passes the caller abort signal to the bounded BFF request", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        })
    );

    const request = searchMiguSongs("test", 1, 20, controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
    });
  });

  it("loads lyric text through the same-origin media proxy", async () => {
    fetchMock.mockResolvedValue(new Response("[00:00]lyric"));
    await expect(
      getMiguLyric("https://lyric.migu.cn/song.lrc")
    ).resolves.toEqual({ lyric: "[00:00]lyric", tlyric: "" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://app.example/proxy?url=https%3A%2F%2Flyric.migu.cn%2Fsong.lrc"
    );
  });

  it("normalizes Migu playlist artwork and lyric metadata before persistence", async () => {
    const detail = await fetchMiguPlaylistDetail("123", async (path) => {
      if (path.includes("resourceinfo")) {
        return JSON.stringify({
          code: "000000",
          resource: [
            {
              title: "Real playlist",
              musicNum: 1,
              imgItem: {
                img: "http://img.migu.cn/list.jpg?size=300#preview",
              },
            },
          ],
        });
      }
      return JSON.stringify({
        code: "000000",
        totalCount: 1,
        list: [
          {
            copyrightId: "copyright",
            contentId: "content",
            songName: "Song",
            singer: "Artist",
            albumImgs: [
              { img: "//img.migu.cn/song.jpg?size=300", imgSizeType: "03" },
            ],
            lrcUrl: "http://lyric.migu.cn/song.lrc?temporary=display",
          },
        ],
      });
    });
    const track = convertMiguSongToMusicTrack(detail.songs[0]);

    expect(detail.coverUrl).toBe("https://img.migu.cn/list.jpg");
    expect(track.pic_id).toBe("https://img.migu.cn/song.jpg");
    expect(track.lyric_id).toBe("https://lyric.migu.cn/song.lrc");
    expect(sanitizeTrackForPersistence(track)).toEqual(track);
  });
});
