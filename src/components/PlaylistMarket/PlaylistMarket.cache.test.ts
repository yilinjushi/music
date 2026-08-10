import { afterEach, describe, expect, it, vi } from "vitest";

const swr = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("swr", () => swr);

import { cachedFetch, isSensitiveCacheKey } from "@/lib/utils/cache";
import { createNeteaseMarketCacheKey } from "./market-cache-key";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PlaylistMarket account-bound cache keys", () => {
  it("uses the NetEase namespace and never writes Cache Storage", async () => {
    const cache = {
      match: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      keys: vi.fn(),
    };
    const cacheStorage = { open: vi.fn().mockResolvedValue(cache) };
    vi.stubGlobal("caches", cacheStorage);
    const key = createNeteaseMarketCacheKey("toplist", 0);

    expect(key).toBe("netease:market-playlist:v3:toplist:0");
    expect(isSensitiveCacheKey(key)).toBe(true);
    await expect(
      cachedFetch(key, async () => [
        { id: "1", name: "Toplist", coverUrl: "", playCount: 1 },
      ])
    ).resolves.toHaveLength(1);

    expect(cacheStorage.open).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(swr.mutate).not.toHaveBeenCalled();
  });
});
