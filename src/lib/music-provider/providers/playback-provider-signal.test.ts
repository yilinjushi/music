import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "@/types/music";
import * as bilibiliApi from "@/lib/bilibili/bilibili-api";
import { getCachedBilibiliAudioFormat } from "@/lib/bilibili/bilibili-cache";
import * as neteaseApi from "@/lib/netease/netease-api";
import { BilibiliApiProvider } from "./bilibili-api-provider";
import { NeteaseApiProvider } from "./netease-api-provider";
import { NeteaseProvider } from "./netease-provider";
import { normalizeAudioUrlForPlayback } from "@/lib/utils/audio-url";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

const track: MusicTrack = {
  id: "123",
  name: "Song",
  artist: ["Artist"],
  album: "Album",
  source: "netease",
  pic_id: "pic",
  url_id: "123",
  lyric_id: "lyric",
};

describe("playback provider AbortSignal propagation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards Bilibili search ownership to the BFF client", async () => {
    const signal = new AbortController().signal;
    const search = vi
      .spyOn(bilibiliApi, "searchBilibiliVideos")
      .mockResolvedValue({ items: [], hasMore: false });

    await new BilibiliApiProvider().search("query", 2, 40, signal);

    expect(search).toHaveBeenCalledWith("query", 2, 40, signal);
  });

  it("keeps colliding Bilibili provider ids isolated by url_id", async () => {
    const first: MusicTrack = {
      ...track,
      id: "bilibili-provider-collision",
      source: "bilibili",
      url_id: "bilibili_BV-first_1",
    };
    const second: MusicTrack = {
      ...first,
      url_id: "bilibili_BV-second_2",
    };
    const getSongUrl = vi
      .spyOn(bilibiliApi, "getBilibiliSongUrl")
      .mockImplementation(async (trackId) => ({
        url: `https://app.example/${trackId}`,
        format: trackId === first.url_id ? "m4s" : "flv",
      }));
    const provider = new BilibiliApiProvider();

    await provider.getUrl(first, 192);
    await provider.getUrl(second, 192);

    expect(getSongUrl).toHaveBeenNthCalledWith(1, first.url_id, undefined);
    expect(getSongUrl).toHaveBeenNthCalledWith(2, second.url_id, undefined);
    expect(getCachedBilibiliAudioFormat(first)).toBe("m4s");
    expect(getCachedBilibiliAudioFormat(second)).toBe("flv");
  });

  it("forwards NetEase search ownership through both default providers", async () => {
    const signal = new AbortController().signal;
    const search = vi.spyOn(neteaseApi, "search").mockResolvedValue({
      data: {
        result: { songs: [], songCount: 0 },
        code: 200,
      },
    });

    await new NeteaseProvider().search("query", 2, 20, signal);
    await new NeteaseApiProvider().search("query", 3, 30, signal);

    expect(search).toHaveBeenNthCalledWith(1, "query", 1, 2, 20, "", signal);
    expect(search).toHaveBeenNthCalledWith(2, "query", 1, 3, 30, "", signal);
  });

  it("keeps GD and session playback references same-origin and opaque", async () => {
    const signal = new AbortController().signal;
    const getSongUrl = vi.spyOn(neteaseApi, "getSongUrl").mockResolvedValue({
      data: {
        data: [
          {
            url: "/music-api/netease/audio?id=123&br=320000",
            br: 320000,
            size: 1,
          },
        ],
      },
    });

    const gdUrl = await new NeteaseProvider().getUrl(track, 320, signal);
    const sessionUrl = await new NeteaseApiProvider().getUrl(
      { ...track, source: "_netease" },
      320,
      signal
    );

    expect(gdUrl).toBe("/music-api/audio?source=netease&id=123&br=320");
    expect(normalizeAudioUrlForPlayback(gdUrl || "")).toBe(gdUrl);
    expect(normalizeAudioUrlForPlayback(sessionUrl || "")).toBe(sessionUrl);
    expect(getSongUrl).toHaveBeenCalledWith("123", 320000, "", signal);
  });
});
