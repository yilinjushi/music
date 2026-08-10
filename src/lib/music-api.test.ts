import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MusicSource, MusicTrack } from "@/types/music";
import { musicApi } from "./music-api";
import { MusicProviderFactory } from "./music-provider";
import { cachedFetch, deleteCachedValue } from "@/lib/utils/cache";
import { isSameRecordingVersion } from "./utils/music-key";

vi.mock("./music-provider", () => ({
  isAbort: (e: unknown) => e instanceof Error && e.name === "AbortError",
  MusicProviderFactory: {
    getProvider: vi.fn(),
  },
}));

vi.mock("@/lib/utils/cache", () => ({
  cachedFetch: vi.fn(),
  deleteCachedValue: vi.fn(),
}));

const createTrack = (
  id: string,
  source: MusicSource,
  name = "Song",
  artist: string[] = ["Artist"]
): MusicTrack => ({
  id,
  name,
  artist,
  album: "Album",
  pic_id: `pic-${id}`,
  url_id: `url-${id}`,
  lyric_id: `lyric-${id}`,
  source,
});

describe("musicApi.searchBestMatch", () => {
  beforeEach(() => {
    vi.mocked(MusicProviderFactory.getProvider).mockReset();
  });

  it("keeps original item order when no ranker is provided", async () => {
    const first = createTrack("first", "joox");
    const second = createTrack("second", "joox");

    vi.mocked(MusicProviderFactory.getProvider).mockReturnValue({
      source: "joox",
      search: vi
        .fn()
        .mockResolvedValue({ items: [first, second], hasMore: false }),
      getUrl: vi.fn(),
      getPic: vi.fn(),
      getLyric: vi.fn(),
    });

    const match = await musicApi.searchBestMatch({
      query: "Song Artist",
      sources: ["joox"],
      predicate: () => true,
    });

    expect(match).toBe(first);
  });

  it("keeps first-match compatibility when the caller omits a predicate", async () => {
    const first = createTrack("first", "joox");
    vi.mocked(MusicProviderFactory.getProvider).mockReturnValue({
      source: "joox",
      search: vi.fn().mockResolvedValue({ items: [first], hasMore: false }),
      getUrl: vi.fn(),
      getPic: vi.fn(),
      getLyric: vi.fn(),
    });

    await expect(
      musicApi.searchBestMatch({
        query: "Song Artist",
        sources: ["joox"],
      })
    ).resolves.toBe(first);
  });

  it("sorts matching items within a single source when ranker is provided", async () => {
    const weaker = createTrack("weaker", "joox", "Song", ["Artist"]);
    const stronger = createTrack("stronger", "joox", "Song", ["Artist"]);

    vi.mocked(MusicProviderFactory.getProvider).mockReturnValue({
      source: "joox",
      search: vi
        .fn()
        .mockResolvedValue({ items: [weaker, stronger], hasMore: false }),
      getUrl: vi.fn(),
      getPic: vi.fn(),
      getLyric: vi.fn(),
    });

    const match = await musicApi.searchBestMatch({
      query: "Song Artist",
      sources: ["joox"],
      predicate: () => true,
      ranker: (track) => (track.id === "stronger" ? 10 : 1),
    });

    expect(match).toBe(stronger);
  });

  it("combines the caller safety gate with a provider-specific predicate", async () => {
    const candidate = createTrack("candidate", "bilibili");
    const providerPredicate = vi.fn(() => true);
    const callerPredicate = vi.fn(() => false);

    vi.mocked(MusicProviderFactory.getProvider).mockReturnValue({
      source: "bilibili",
      search: vi.fn().mockResolvedValue({ items: [candidate], hasMore: false }),
      getUrl: vi.fn(),
      getPic: vi.fn(),
      getLyric: vi.fn(),
      getAutoMatchPredicate: () => providerPredicate,
    });

    await expect(
      musicApi.searchBestMatch({
        query: "Song Artist",
        sources: ["bilibili"],
        predicate: callerPredicate,
        targetTrack: createTrack("target", "_netease"),
      })
    ).resolves.toBeNull();
    expect(callerPredicate).toHaveBeenCalledWith(candidate);
    expect(providerPredicate).not.toHaveBeenCalled();
  });

  it("does not let a Bilibili predicate admit a wrong recording version", async () => {
    const target = createTrack("target", "_netease", "爱错", ["王力宏"]);
    const wrongLiveDuet = createTrack(
      "wrong-live",
      "bilibili",
      "愛錯 (feat. 單依純) (Live)",
      ["UP 主"]
    );
    const providerPredicate = vi.fn(() => true);

    vi.mocked(MusicProviderFactory.getProvider).mockReturnValue({
      source: "bilibili",
      search: vi
        .fn()
        .mockResolvedValue({ items: [wrongLiveDuet], hasMore: false }),
      getUrl: vi.fn(),
      getPic: vi.fn(),
      getLyric: vi.fn(),
      getAutoMatchPredicate: () => providerPredicate,
    });

    await expect(
      musicApi.searchBestMatch({
        query: "爱错 王力宏",
        sources: ["bilibili"],
        predicate: (candidate) => isSameRecordingVersion(target, candidate),
        targetTrack: target,
      })
    ).resolves.toBeNull();
    expect(providerPredicate).not.toHaveBeenCalled();
  });

  it("preserves provider constraints when the caller omits a predicate", async () => {
    const rejected = createTrack("rejected", "bilibili");
    const accepted = createTrack("accepted", "bilibili");

    vi.mocked(MusicProviderFactory.getProvider).mockReturnValue({
      source: "bilibili",
      search: vi
        .fn()
        .mockResolvedValue({ items: [rejected, accepted], hasMore: false }),
      getUrl: vi.fn(),
      getPic: vi.fn(),
      getLyric: vi.fn(),
      getAutoMatchPredicate: () => (candidate) => candidate.id === "accepted",
    });

    await expect(
      musicApi.searchBestMatch({
        query: "Song Artist",
        sources: ["bilibili"],
        targetTrack: createTrack("target", "_netease"),
      })
    ).resolves.toBe(accepted);
  });
});

describe("musicApi local metadata", () => {
  beforeEach(() => {
    vi.mocked(MusicProviderFactory.getProvider).mockReset();
    vi.mocked(cachedFetch).mockReset();
    // 透传：直接执行 fetcher 并返回结果，跳过 Cache API
    vi.mocked(cachedFetch).mockImplementation(async (_key, fetcher) =>
      fetcher()
    );
  });

  it("loads local cover from the local provider via cachedFetch", async () => {
    const getPic = vi.fn().mockResolvedValue("data:image/jpeg;base64,abc");
    vi.mocked(MusicProviderFactory.getProvider).mockReturnValue({
      source: "joox",
      search: vi.fn(),
      getUrl: vi.fn(),
      getPic,
      getLyric: vi.fn(),
    });

    await expect(musicApi.getPic("/music/song.mp3", "local")).resolves.toBe(
      "data:image/jpeg;base64,abc"
    );
    expect(getPic).toHaveBeenCalledWith(
      { id: "/music/song.mp3", pic_id: "/music/song.mp3", source: "local" },
      800
    );
  });

  it("loads local lyrics from the local provider via cachedFetch", async () => {
    const getLyric = vi
      .fn()
      .mockResolvedValue({ lyric: "[00:00.00]歌词", tlyric: "" });
    vi.mocked(MusicProviderFactory.getProvider).mockReturnValue({
      source: "joox",
      search: vi.fn(),
      getUrl: vi.fn(),
      getPic: vi.fn(),
      getLyric,
    });

    await expect(
      musicApi.getLyric("/music/song.mp3", "local")
    ).resolves.toEqual({
      lyric: "[00:00.00]歌词",
      tlyric: "",
    });
    expect(getLyric).toHaveBeenCalledWith(
      {
        id: "/music/song.mp3",
        lyric_id: "/music/song.mp3",
        source: "local",
      },
      undefined
    );
  });

  it("propagates lyric cancellation instead of converting it to no lyrics", async () => {
    const controller = new AbortController();
    const getLyric = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    });
    vi.mocked(MusicProviderFactory.getProvider).mockReturnValue({
      source: "joox",
      search: vi.fn(),
      getUrl: vi.fn(),
      getPic: vi.fn(),
      getLyric,
    });

    await expect(
      musicApi.getLyric("lyric-id", "joox", controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("musicApi URL cache invalidation", () => {
  beforeEach(() => {
    vi.mocked(MusicProviderFactory.getProvider).mockReset();
    vi.mocked(cachedFetch).mockClear();
    vi.mocked(deleteCachedValue).mockReset();
  });

  it("keeps resolved provider capabilities out of Cache Storage", async () => {
    const signedUrl =
      "https://audio.test/song.mp3?X-Amz-Signature=capability-canary";
    const getUrl = vi.fn().mockResolvedValue(signedUrl);
    vi.mocked(MusicProviderFactory.getProvider).mockReturnValue({
      source: "joox",
      search: vi.fn(),
      getUrl,
      getPic: vi.fn(),
      getLyric: vi.fn(),
    });
    const controller = new AbortController();
    const providerTrack = {
      ...createTrack("track-123", "joox"),
      url_id: "provider-url-123",
    };

    await expect(
      musicApi.getUrl(providerTrack, 320, controller.signal)
    ).resolves.toBe(signedUrl);
    expect(getUrl).toHaveBeenCalledOnce();
    expect(getUrl).toHaveBeenCalledWith(providerTrack, 320, controller.signal);
    expect(cachedFetch).not.toHaveBeenCalled();
  });

  it("preserves url_id when provider ids collide", async () => {
    const first = {
      ...createTrack("same-id", "joox"),
      url_id: "recording-first",
    };
    const second = { ...first, url_id: "recording-second" };
    const getUrl = vi.fn(async (requestedTrack: MusicTrack) =>
      requestedTrack.url_id === first.url_id
        ? "https://audio.test/first.mp3"
        : "https://audio.test/second.mp3"
    );
    vi.mocked(MusicProviderFactory.getProvider).mockReturnValue({
      source: "joox",
      search: vi.fn(),
      getUrl,
      getPic: vi.fn(),
      getLyric: vi.fn(),
    });

    await expect(musicApi.getUrl(first, 192)).resolves.toBe(
      "https://audio.test/first.mp3"
    );
    await expect(musicApi.getUrl(second, 192)).resolves.toBe(
      "https://audio.test/second.mp3"
    );
    expect(getUrl).toHaveBeenNthCalledWith(1, first, 192, undefined);
    expect(getUrl).toHaveBeenNthCalledWith(2, second, 192, undefined);
  });

  it("deletes the exact cachedFetch key for a provider URL", async () => {
    const controller = new AbortController();
    const providerTrack = {
      ...createTrack("track-123", "joox"),
      url_id: "provider-url-123",
    };

    await musicApi.deleteUrlCache(providerTrack, 320, controller.signal);

    expect(deleteCachedValue).toHaveBeenNthCalledWith(
      1,
      "url:joox:track-123:320",
      controller.signal
    );
    expect(deleteCachedValue).toHaveBeenNthCalledWith(
      2,
      "url:joox:provider-url-123:320",
      controller.signal
    );
  });

  it("does not invent a cache entry for a direct URL", async () => {
    await musicApi.deleteUrlCache(
      {
        ...createTrack("direct-url", "url"),
        url_id: "https://audio.test/song.mp3",
      },
      192
    );

    expect(deleteCachedValue).not.toHaveBeenCalled();
  });
});
