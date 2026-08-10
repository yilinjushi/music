import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useUrlCacheStore,
  buildUrlCacheKey,
  purgeLegacyPersistedUrlCache,
} from "./url-cache-store";
import { idbStorage } from "@/lib/storage-adapter";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("@/lib/utils/blob-registry", () => ({
  revokeBlobUrl: vi.fn(),
}));

const { revokeBlobUrl } = await import("@/lib/utils/blob-registry");

describe("buildUrlCacheKey", () => {
  it("uses an opaque full identity for non-local sources", () => {
    const key = buildUrlCacheKey("netease", "123", "url-123", "128");
    expect(key).toMatch(/^netease:opaque:[0-9a-f-]{36}:128$/);
    expect(key).not.toContain("url-123");
  });

  it("separates equal source and id values by url_id", () => {
    const first = buildUrlCacheKey("joox", "same-id", "url-first", "192");
    const second = buildUrlCacheKey("joox", "same-id", "url-second", "192");

    expect(first).not.toBe(second);
    useUrlCacheStore.getState().set(first, "https://media.example/first.mp3");
    useUrlCacheStore.getState().set(second, "https://media.example/second.mp3");
    expect(useUrlCacheStore.getState().get(first)).toBe(
      "https://media.example/first.mp3"
    );
    expect(useUrlCacheStore.getState().get(second)).toBe(
      "https://media.example/second.mp3"
    );
  });

  it("should use urlId for local source", () => {
    const key = buildUrlCacheKey(
      "local",
      "local-456",
      "/music/song.mp3",
      "320"
    );
    expect(key).toMatch(/^local:opaque:[0-9a-f-]{36}:320$/);
    expect(key).not.toContain("/music/song.mp3");
  });

  it("should use urlId for direct URL source", () => {
    const rawUrl = "https://media.test/audio.mp3";
    const key = buildUrlCacheKey("url", "url-789", rawUrl, "192");
    expect(key).toMatch(/^url:opaque:[0-9a-f-]{36}:192$/);
    expect(key).not.toContain(rawUrl);
  });

  it("should fallback to trackId when local urlId is missing", () => {
    const key = buildUrlCacheKey("local", "local-456", undefined, "128");
    expect(key).toMatch(/^local:opaque:[0-9a-f-]{36}:128$/);
    expect(key).not.toContain("local-456");
  });

  it("is deterministic and separates distinct direct URLs", () => {
    const first = buildUrlCacheKey(
      "url",
      "same-id",
      "https://media.test/a.mp3",
      "192"
    );
    expect(
      buildUrlCacheKey("url", "same-id", "https://media.test/a.mp3", "192")
    ).toBe(first);
    expect(
      buildUrlCacheKey("url", "same-id", "https://media.test/b.mp3", "192")
    ).not.toBe(first);
  });

  it("rejects sensitive URL identifiers", () => {
    expect(() =>
      buildUrlCacheKey(
        "url",
        "url-1",
        "https://media.test/a.mp3?MUSIC_U=canary",
        "192"
      )
    ).toThrow(/敏感数据/);
  });

  it("purges rather than migrates the legacy IndexedDB URL cache", async () => {
    await purgeLegacyPersistedUrlCache();
    expect(idbStorage.removeItem).toHaveBeenCalledWith("oh_url_cache_store");
    expect("persist" in useUrlCacheStore).toBe(false);
  });
});

describe("UrlCacheStore", () => {
  beforeEach(() => {
    useUrlCacheStore.setState({ urlMap: {}, generation: 0 });
    vi.clearAllMocks();
  });

  describe("get", () => {
    it("should return undefined for missing key", () => {
      expect(useUrlCacheStore.getState().get("missing")).toBeUndefined();
    });

    it("should return cached URL", () => {
      const key = buildUrlCacheKey("netease", "123", "123", "128");
      useUrlCacheStore.getState().set(key, "https://example.com/a.mp3");
      expect(useUrlCacheStore.getState().get(key)).toBe(
        "https://example.com/a.mp3"
      );
    });
  });

  describe("set", () => {
    it("should store URL mapping", () => {
      const key = buildUrlCacheKey("netease", "123", "123", "128");
      useUrlCacheStore.getState().set(key, "https://example.com/a.mp3");
      expect(useUrlCacheStore.getState().urlMap).toEqual({
        [key]: "https://example.com/a.mp3",
      });
    });

    it("should keep different qualities in separate keys", () => {
      const key128 = buildUrlCacheKey("netease", "123", "123", "128");
      const key320 = buildUrlCacheKey("netease", "123", "123", "320");
      useUrlCacheStore.getState().set(key128, "https://example.com/128.mp3");
      useUrlCacheStore.getState().set(key320, "https://example.com/320.mp3");

      expect(useUrlCacheStore.getState().get(key128)).toBe(
        "https://example.com/128.mp3"
      );
      expect(useUrlCacheStore.getState().get(key320)).toBe(
        "https://example.com/320.mp3"
      );
    });

    it("should revoke old blob URL when overwritten", () => {
      const key = buildUrlCacheKey("netease", "123", "123", "128");
      const blobUrl = "blob:https://example.com/old";
      useUrlCacheStore.getState().set(key, blobUrl);
      useUrlCacheStore.getState().set(key, "https://example.com/new.mp3");

      expect(revokeBlobUrl).toHaveBeenCalledWith(blobUrl);
      expect(useUrlCacheStore.getState().get(key)).toBe(
        "https://example.com/new.mp3"
      );
    });

    it("should not revoke old non-blob URL when overwritten", () => {
      const key = buildUrlCacheKey("netease", "123", "123", "128");
      useUrlCacheStore.getState().set(key, "https://example.com/old.mp3");
      useUrlCacheStore.getState().set(key, "https://example.com/new.mp3");

      expect(revokeBlobUrl).not.toHaveBeenCalled();
    });

    it("should not revoke when setting same blob URL", () => {
      const key = buildUrlCacheKey("netease", "123", "123", "128");
      const blobUrl = "blob:https://example.com/same";
      useUrlCacheStore.getState().set(key, blobUrl);
      useUrlCacheStore.getState().set(key, blobUrl);

      expect(revokeBlobUrl).not.toHaveBeenCalled();
    });

    it("refuses sensitive plain and double-encoded URL values", () => {
      const key = buildUrlCacheKey("netease", "123", "123", "128");
      useUrlCacheStore
        .getState()
        .set(key, "https://media.test/a?Authorization=canary");
      useUrlCacheStore
        .getState()
        .set(key, "https://media.test/a?Cookie%253DMUSIC_U-canary");
      useUrlCacheStore
        .getState()
        .set(key, "https://media.test/a?X-Amz-Signature=canary");

      expect(useUrlCacheStore.getState().get(key)).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("should remove URL mapping", () => {
      const key = buildUrlCacheKey("netease", "123", "123", "128");
      useUrlCacheStore.getState().set(key, "https://example.com/a.mp3");
      useUrlCacheStore.getState().delete(key);

      expect(useUrlCacheStore.getState().get(key)).toBeUndefined();
    });

    it("should revoke blob URL when deleted", () => {
      const key = buildUrlCacheKey("netease", "123", "123", "128");
      const blobUrl = "blob:https://example.com/a";
      useUrlCacheStore.getState().set(key, blobUrl);
      useUrlCacheStore.getState().delete(key);

      expect(revokeBlobUrl).toHaveBeenCalledWith(blobUrl);
    });

    it("should not revoke non-blob URL when deleted", () => {
      const key = buildUrlCacheKey("netease", "123", "123", "128");
      useUrlCacheStore.getState().set(key, "https://example.com/a.mp3");
      useUrlCacheStore.getState().delete(key);

      expect(revokeBlobUrl).not.toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("should remove all URL mappings", async () => {
      useUrlCacheStore.getState().set("track-1", "https://example.com/1.mp3");
      useUrlCacheStore.getState().set("track-2", "https://example.com/2.mp3");

      await useUrlCacheStore.getState().clear();

      expect(useUrlCacheStore.getState().urlMap).toEqual({});
      expect(idbStorage.removeItem).toHaveBeenCalledWith("oh_url_cache_store");
    });

    it("should revoke all blob URLs", async () => {
      const blobUrl = "blob:https://example.com/audio";
      useUrlCacheStore.getState().set("track-1", blobUrl);

      await useUrlCacheStore.getState().clear();

      expect(revokeBlobUrl).toHaveBeenCalledWith(blobUrl);
    });

    it("revokes write leases captured before clear", async () => {
      const key = buildUrlCacheKey("netease", "123", "123", "128");
      const generation = useUrlCacheStore.getState().generation;

      await useUrlCacheStore.getState().clear();

      expect(
        useUrlCacheStore
          .getState()
          .setIfCurrentGeneration(
            key,
            "https://example.com/stale.mp3",
            generation
          )
      ).toBe(false);
      expect(useUrlCacheStore.getState().get(key)).toBeUndefined();
    });
  });
});
