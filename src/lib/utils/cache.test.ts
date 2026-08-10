import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const swr = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("swr", () => swr);

import {
  cachedFetch,
  containsSensitiveCacheData,
  deleteCachedValue,
  isSensitiveCacheKey,
  purgeLegacyNeteaseDataCache,
  purgeLegacyResolvedUrlCache,
} from "./cache";

const cache = {
  match: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  keys: vi.fn(),
};
const cacheStorage = { open: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  cache.match.mockResolvedValue(undefined);
  cache.put.mockResolvedValue(undefined);
  cache.delete.mockResolvedValue(true);
  cache.keys.mockResolvedValue([]);
  cacheStorage.open.mockResolvedValue(cache);
  vi.stubGlobal("caches", cacheStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("frontend data cache credential boundary", () => {
  it("detects sensitive keys, fields, encoded values, and Response objects", () => {
    expect(isSensitiveCacheKey("netease:cookie:user")).toBe(true);
    expect(isSensitiveCacheKey("netease:MUSIC_U:canary")).toBe(true);
    expect(isSensitiveCacheKey("netease.cookie.canary")).toBe(true);
    expect(isSensitiveCacheKey("netease:song:123")).toBe(true);
    expect(isSensitiveCacheKey("pic:_netease:123:800")).toBe(true);
    expect(isSensitiveCacheKey("lyric:netease:123")).toBe(true);
    expect(isSensitiveCacheKey("market-playlist:v2:toplist:0")).toBe(true);
    expect(
      containsSensitiveCacheData({ nested: { note: "MUSIC_U%253Dcanary" } })
    ).toBe(true);
    expect(
      containsSensitiveCacheData({
        artwork: "https://cdn.test/cover.jpg?X-Amz-Signature=capability-canary",
      })
    ).toBe(true);
    expect(
      containsSensitiveCacheData({
        nested: "signature%25253Dencoded-capability-canary",
      })
    ).toBe(true);
    expect(containsSensitiveCacheData({ authorization: "Bearer canary" })).toBe(
      true
    );
    expect(containsSensitiveCacheData(Response.json({ ok: true }))).toBe(true);
    expect(
      containsSensitiveCacheData({
        artwork: "https://cdn.test/cover.jpg?txSecret=random-unknown-canary",
      })
    ).toBe(true);
    expect(
      containsSensitiveCacheData(
        "https://user:password@cdn.test/query-free-cover.jpg"
      )
    ).toBe(true);
    expect(
      containsSensitiveCacheData(
        "embedded https://cdn.test/cover.jpg#private-fragment-canary"
      )
    ).toBe(true);
    expect(
      containsSensitiveCacheData("https://cdn.test/public-cover.jpg")
    ).toBe(false);
    expect(
      containsSensitiveCacheData(new URLSearchParams({ resize: "800" }))
    ).toBe(true);
  });

  it("fetches a sensitive key without touching Cache Storage or SWR", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });

    await expect(cachedFetch("cookie:canary-key", fetcher)).resolves.toEqual({
      ok: true,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cacheStorage.open).not.toHaveBeenCalled();
    expect(swr.mutate).not.toHaveBeenCalled();
  });

  it("returns a sensitive response without persisting it to disk or SWR", async () => {
    const leaked = { nested: { note: "MUSIC_U=canary-response" } };

    await expect(
      cachedFetch("netease:song:123", async () => leaked)
    ).resolves.toBe(leaked);
    expect(cache.put).not.toHaveBeenCalled();
    expect(swr.mutate).not.toHaveBeenCalled();
  });

  it("never persists the account-bound NetEase namespace", async () => {
    const safe = { id: 123, name: "Safe song" };

    await expect(
      cachedFetch("netease:song:123", async () => safe)
    ).resolves.toBe(safe);
    expect(cacheStorage.open).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(swr.mutate).not.toHaveBeenCalled();
  });

  it("never persists a retired session-derived market playlist key", async () => {
    const market = [{ id: "1", name: "Session-derived toplist" }];

    await expect(
      cachedFetch("market-playlist:v2:toplist:0", async () => market)
    ).resolves.toBe(market);
    expect(cacheStorage.open).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(swr.mutate).not.toHaveBeenCalled();
  });

  it("persists and publishes a safe public response", async () => {
    const safe = { id: 123, name: "Safe song" };

    await expect(
      cachedFetch("public:song:123", async () => safe)
    ).resolves.toBe(safe);
    expect(cache.put).toHaveBeenCalledOnce();
    expect(swr.mutate).toHaveBeenCalledWith("public:song:123", safe, {
      revalidate: false,
    });
  });

  it.each([
    "https://cdn.test/cover.jpg?txSecret=random-query-canary",
    "https://cdn.test/cover.jpg?random_unknown_signature=random-query-canary",
    "https://cdn.test/cover.jpg#random-fragment-canary",
    "https://user:password@cdn.test/cover.jpg",
    "https%253A%252F%252Fcdn.test%252Fcover.jpg%253Fopaque%253Dencoded-query-canary",
  ])(
    "returns but never persists or publishes a stateful HTTP URL: %s",
    async (unsafeUrl) => {
      await expect(
        cachedFetch("public:artwork:unsafe", async () => ({ url: unsafeUrl }))
      ).resolves.toEqual({ url: unsafeUrl });
      expect(cache.put).not.toHaveBeenCalled();
      expect(swr.mutate).not.toHaveBeenCalled();
    }
  );

  it("deletes a disk entry containing an unknown signed URL", async () => {
    cache.match.mockResolvedValue(
      Response.json({
        url: "https://cdn.test/audio.mp3?txSecret=disk-canary",
      })
    );
    const fresh = { id: 789, name: "Fresh public metadata" };

    await expect(
      cachedFetch("public:song:789", async () => fresh)
    ).resolves.toEqual(fresh);
    expect(cache.delete).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledOnce();
    expect(swr.mutate).toHaveBeenCalledWith("public:song:789", fresh, {
      revalidate: false,
    });
  });

  it("deletes a poisoned disk entry before fetching fresh data", async () => {
    cache.match.mockResolvedValue(
      Response.json({ nested: { note: "MUSIC_U=canary-disk" } })
    );
    const fresh = { id: 456, name: "Fresh song" };

    await expect(
      cachedFetch("public:song:456", async () => fresh)
    ).resolves.toBe(fresh);
    expect(cache.delete).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledOnce();
    const storedBody = JSON.stringify(
      await vi.mocked(cache.put).mock.calls[0][1].clone().json()
    );
    expect(storedBody).not.toContain("canary-disk");
  });

  it("deletes one cache entry from Cache Storage and SWR state", async () => {
    await deleteCachedValue("url:joox:track-1:192");

    expect(cache.delete).toHaveBeenCalledOnce();
    expect(String(cache.delete.mock.calls[0][0].url)).toBe(
      "https://cache.local/url%3Ajoox%3Atrack-1%3A192"
    );
    expect(swr.mutate).toHaveBeenCalledWith("url:joox:track-1:192", undefined, {
      revalidate: false,
    });
  });

  it("purges every legacy resolved URL entry without deleting metadata", async () => {
    const legacyProvider = new Request(
      "https://cache.local/url%3Ajoox%3Atrack-1%3A192"
    );
    const legacyDirect = new Request(
      "https://cache.local/url%3Aurl%3Ahttps%253A%252F%252Fmedia.test%252Fsigned.mp3%3A192"
    );
    const metadata = new Request(
      "https://cache.local/pic%3Ajoox%3Atrack-1%3A800"
    );
    cache.keys.mockResolvedValue([legacyProvider, metadata, legacyDirect]);

    await purgeLegacyResolvedUrlCache();

    expect(cache.delete).toHaveBeenCalledTimes(2);
    const deletedUrls = cache.delete.mock.calls.map(
      ([request]) => (request as Request).url
    );
    expect(deletedUrls).toEqual([legacyProvider.url, legacyDirect.url]);
    expect(deletedUrls).not.toContain(metadata.url);
  });

  it("purges every legacy NetEase and market response from disk and SWR", async () => {
    const playlist = new Request(
      "https://cache.local/netease%3Aplaylist%3Aprivate-1"
    );
    const song = new Request("https://cache.local/netease%3Asong%3Aprivate-2");
    const derivedArtwork = new Request(
      "https://cache.local/pic%3A_netease%3Aprivate-2%3A800"
    );
    const marketToplist = new Request(
      "https://cache.local/market-playlist%3Av2%3Atoplist%3A0"
    );
    const marketCategory = new Request(
      "https://cache.local/market-playlist%3Av2%3Afeatured%3A30"
    );
    const publicMetadata = new Request("https://cache.local/public%3Asong%3A3");
    cache.keys.mockResolvedValue([
      playlist,
      publicMetadata,
      song,
      derivedArtwork,
      marketToplist,
      marketCategory,
    ]);

    await purgeLegacyNeteaseDataCache();

    const deletedUrls = cache.delete.mock.calls.map(
      ([request]) => (request as Request).url
    );
    expect(deletedUrls).toEqual([
      playlist.url,
      song.url,
      derivedArtwork.url,
      marketToplist.url,
      marketCategory.url,
    ]);
    expect(swr.mutate).toHaveBeenCalledWith(expect.any(Function), undefined, {
      revalidate: false,
    });
    const predicate = swr.mutate.mock.calls[0][0] as (key: unknown) => boolean;
    expect(predicate("netease:playlist:private-1")).toBe(true);
    expect(predicate("pic:_netease:private-1:800")).toBe(true);
    expect(predicate("market-playlist:v2:toplist:0")).toBe(true);
    expect(predicate("public:song:3")).toBe(false);
  });

  it("does not publish a deletion after its recovery request is aborted", async () => {
    const controller = new AbortController();
    cache.delete.mockImplementation(async () => {
      controller.abort();
      return true;
    });

    await deleteCachedValue("url:joox:track-2:192", controller.signal);

    expect(cache.delete).toHaveBeenCalledOnce();
    expect(swr.mutate).not.toHaveBeenCalled();
  });

  it("does not persist a fetched value after its owner is superseded", async () => {
    const controller = new AbortController();
    let finishFetch!: (value: string) => void;
    const pending = cachedFetch(
      "url:joox:stale:192",
      () =>
        new Promise<string>((resolve) => {
          finishFetch = resolve;
        }),
      undefined,
      controller.signal
    );

    await vi.waitFor(() => expect(finishFetch).toBeTypeOf("function"));
    controller.abort();
    finishFetch("https://audio.test/stale.mp3");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.put).not.toHaveBeenCalled();
    expect(swr.mutate).not.toHaveBeenCalled();
  });
});
