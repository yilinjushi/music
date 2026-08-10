import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "@/types/music";
import { musicApi } from "@/lib/music-api";
import { invalidateTrackUrlCache, resolveTrackUrl } from "./audio-resolver";
import { buildUrlCacheKey, useUrlCacheStore } from "@/store/url-cache-store";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("@/lib/music-api", () => ({
  musicApi: {
    getUrl: vi.fn(),
    deleteUrlCache: vi.fn(),
  },
}));

const track: MusicTrack = {
  id: "track-123",
  name: "Signed URL",
  artist: ["Artist"],
  album: "Album",
  source: "joox",
  pic_id: "pic-track-123",
  url_id: "provider-url-id",
  lyric_id: "lyric-track-123",
};

describe("audio URL recovery cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { onLine: true });
    useUrlCacheStore.setState({ urlMap: {}, generation: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes the old signed URL before resolving and storing a fresh one", async () => {
    const key = buildUrlCacheKey("joox", track.id, track.url_id, "192");
    useUrlCacheStore.getState().set(key, "https://audio.test/old-signed.mp3");

    await expect(resolveTrackUrl(track, 192)).resolves.toEqual({
      url: "https://audio.test/old-signed.mp3",
    });
    expect(musicApi.getUrl).not.toHaveBeenCalled();

    await invalidateTrackUrlCache(track, 192);

    expect(useUrlCacheStore.getState().get(key)).toBeUndefined();
    expect(musicApi.deleteUrlCache).toHaveBeenCalledWith(track, 192, undefined);

    vi.mocked(musicApi.getUrl).mockResolvedValue(
      "https://audio.test/new-signed.mp3"
    );
    await expect(resolveTrackUrl(track, 192)).resolves.toEqual({
      url: "https://audio.test/new-signed.mp3",
    });
    expect(useUrlCacheStore.getState().get(key)).toBe(
      "https://audio.test/new-signed.mp3"
    );
    expect(musicApi.getUrl).toHaveBeenCalledWith(track, 192, undefined);
  });

  it("keeps equal source and id recordings isolated by url_id end to end", async () => {
    const first = { ...track, url_id: "recording-first" };
    const second = { ...track, url_id: "recording-second" };
    const firstKey = buildUrlCacheKey(
      first.source,
      first.id,
      first.url_id,
      "192"
    );
    const secondKey = buildUrlCacheKey(
      second.source,
      second.id,
      second.url_id,
      "192"
    );
    vi.mocked(musicApi.getUrl).mockImplementation(async (requestedTrack) =>
      requestedTrack.url_id === first.url_id
        ? "https://audio.test/first.mp3"
        : "https://audio.test/second.mp3"
    );

    await expect(resolveTrackUrl(first, 192)).resolves.toEqual({
      url: "https://audio.test/first.mp3",
    });
    await expect(resolveTrackUrl(second, 192)).resolves.toEqual({
      url: "https://audio.test/second.mp3",
    });

    expect(firstKey).not.toBe(secondKey);
    expect(musicApi.getUrl).toHaveBeenNthCalledWith(1, first, 192, undefined);
    expect(musicApi.getUrl).toHaveBeenNthCalledWith(2, second, 192, undefined);
    expect(useUrlCacheStore.getState().get(firstKey)).toBe(
      "https://audio.test/first.mp3"
    );
    expect(useUrlCacheStore.getState().get(secondKey)).toBe(
      "https://audio.test/second.mp3"
    );

    vi.mocked(musicApi.getUrl).mockClear();
    await resolveTrackUrl(first, 192);
    await resolveTrackUrl(second, 192);
    expect(musicApi.getUrl).not.toHaveBeenCalled();
  });

  it("does not repopulate the URL store after its request is superseded", async () => {
    const key = buildUrlCacheKey("joox", track.id, track.url_id, "192");
    const controller = new AbortController();
    let finishProvider!: (url: string) => void;
    vi.mocked(musicApi.getUrl).mockReturnValue(
      new Promise((resolve) => {
        finishProvider = resolve;
      })
    );

    const pending = resolveTrackUrl(track, 192, controller.signal);
    controller.abort();
    finishProvider("https://audio.test/stale-signed.mp3");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(useUrlCacheStore.getState().get(key)).toBeUndefined();
  });

  it("does not repopulate the URL store when clear wins a deferred request", async () => {
    const key = buildUrlCacheKey("joox", track.id, track.url_id, "192");
    let finishProvider!: (url: string) => void;
    vi.mocked(musicApi.getUrl).mockReturnValue(
      new Promise((resolve) => {
        finishProvider = resolve;
      })
    );

    const pending = resolveTrackUrl(track, 192);
    await useUrlCacheStore.getState().clear();
    finishProvider("https://audio.test/pre-clear-request.mp3");

    await expect(pending).resolves.toEqual({
      url: "https://audio.test/pre-clear-request.mp3",
    });
    expect(useUrlCacheStore.getState().get(key)).toBeUndefined();
  });

  it("normalizes a fresh HTTP provider URL before returning and caching it", async () => {
    const key = buildUrlCacheKey("joox", track.id, track.url_id, "192");
    vi.mocked(musicApi.getUrl).mockResolvedValue(
      "http://media.example/fresh.mp3"
    );
    const playable = `${window.location.origin}/proxy?url=${encodeURIComponent(
      "https://media.example/fresh.mp3"
    )}`;

    await expect(resolveTrackUrl(track, 192)).resolves.toEqual({
      url: playable,
    });
    expect(useUrlCacheStore.getState().get(key)).toBe(playable);
  });
});
