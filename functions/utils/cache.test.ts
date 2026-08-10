// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifySensitiveData,
  containsSensitiveData,
  createCacheKey,
  getFromCache,
  isCapabilityRequest,
  putToCache,
} from "./cache";

class MemoryCache {
  records = new Map<string, Response>();
  putCalls: string[] = [];
  deleteCalls: string[] = [];

  async match(request: Request) {
    return this.records.get(request.url)?.clone();
  }

  async put(request: Request, response: Response) {
    this.putCalls.push(request.url);
    this.records.set(request.url, response.clone());
  }

  async delete(request: Request) {
    this.deleteCalls.push(request.url);
    return this.records.delete(request.url);
  }
}

let memoryCache: MemoryCache;

beforeEach(() => {
  memoryCache = new MemoryCache();
  vi.stubGlobal("caches", {
    open: vi.fn().mockResolvedValue(memoryCache),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("server cache credential boundary", () => {
  it("uses a canonical hash instead of the raw query in cache keys", async () => {
    const first = await createCacheKey(
      new Request("https://music.example/music-api?name=private-search&page=1")
    );
    const reordered = await createCacheKey(
      new Request("https://music.example/music-api?page=1&name=private-search")
    );

    expect(first?.url).toBe(reordered?.url);
    expect(first?.url).not.toContain("private-search");
    expect(new URL(first!.url).searchParams.get("q")).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    "https://music.example/music-api?music_u=canary",
    "https://music.example/music-api?target=https%3A%2F%2Fmusic.163.com%2F%3FMUSIC_U%3Dcanary",
    "https://music.example/music-api?types=url&id=track-canary",
    "https://music.example/music-api/audio?source=joox&id=track-canary&br=192",
    "https://music.example/music-api/netease/audio?id=1&br=320000",
    "https://music.example/music-api/qqmusic/audio?songmid=mid&quality=320k",
    "https://music.example/music-api/migu/audio?copyrightId=1&contentId=2&br=320",
    "https://music.example/music-api?url=https%3A%2F%2Fcdn.example%2Fa.mp3%3FX-Amz-Signature%3Dunique-cache-canary",
    "https://music.example/proxy?url=https%3A%2F%2Fcdn.example%2Fa.mp3%3Fapi_token%3Dunique-api-token-canary",
  ])("declares a sensitive or audio request uncacheable: %s", async (url) => {
    expect(await createCacheKey(new Request(url))).toBeNull();
  });

  it("never stores account requests or nested credential-shaped responses", async () => {
    const accountStored = await putToCache(
      new Request("https://music.example/music-api/search", {
        headers: { Cookie: "session=opaque" },
      }),
      Response.json({ ok: true }),
      "api"
    );
    const leakedStored = await putToCache(
      new Request("https://music.example/music-api?name=safe"),
      Response.json({ nested: { note: "MUSIC_U=canary" } }),
      "api"
    );

    expect(accountStored).toBe(false);
    expect(leakedStored).toBe(false);
    expect(memoryCache.putCalls).toEqual([]);
  });

  it("evicts a poisoned cached response instead of returning it", async () => {
    const request = new Request(
      "https://music.example/music-api?name=safe-cache-entry"
    );
    const key = await createCacheKey(request);
    memoryCache.records.set(
      key!.url,
      Response.json({ data: { authorization: "Bearer canary" } })
    );

    await expect(getFromCache(request)).resolves.toBeNull();
    expect(memoryCache.deleteCalls).toEqual([key!.url]);
  });

  it("detects encoded values and sensitive field names recursively", () => {
    expect(
      containsSensitiveData({ safe: [{ note: "MUSIC_U%253Dcanary" }] })
    ).toBe(true);
    expect(containsSensitiveData({ "x-real-cookie": "canary" })).toBe(true);
    expect(
      containsSensitiveData({
        safe: "X-Goog-Signature%2525253Dfour-round-canary",
      })
    ).toBe(true);
    expect(containsSensitiveData({ password: "unique-password-canary" })).toBe(
      true
    );
    expect(containsSensitiveData({ "Key-Pair-Id": "unique-key-canary" })).toBe(
      true
    );
    expect(
      containsSensitiveData("malformed%=safe&token%253Dunique-token-canary")
    ).toBe(true);
    expect(
      containsSensitiveData({ access_token: "unique-access-token-canary" })
    ).toBe(true);
    for (const name of [
      "api_token",
      "secret",
      "X-Request-Key",
      "vkey",
      "upsig",
      "deadline",
    ]) {
      let encoded = `${name}=four-pass-canary`;
      for (let pass = 0; pass < 4; pass += 1) {
        encoded = encodeURIComponent(encoded);
      }
      expect(containsSensitiveData(encoded)).toBe(true);
    }
  });

  it("rejects bare and repeatedly encoded credentials in response-like data", () => {
    for (const value of [
      "Bearer account-secret",
      "Basic YWNjb3VudC1zZWNyZXQ=",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMiLCJleHAiOjk5OTk5OTk5OTl9.dGVzdC1zaWduYXR1cmUtYnl0ZXM",
    ]) {
      let encoded = value;
      for (let pass = 0; pass < 4; pass += 1) {
        encoded = encodeURIComponent(encoded);
      }
      expect(containsSensitiveData({ note: encoded })).toBe(true);
      expect(classifySensitiveData(encoded)).toMatchObject({
        hasCredential: true,
      });
    }
  });

  it("allows ordinary auth-like titles and dotted provider metadata", () => {
    expect(
      classifySensitiveData({
        name: "Basic Instinct",
        album: "Signature Collection",
        artist: "MAC DeMarco",
        id: "abc.def.ghi",
        site: "www.youtube.com",
      })
    ).toEqual({ hasCapability: false, hasCredential: false });
  });

  it("fails closed on recursive, wide and oversized untrusted structures", () => {
    let deep: Record<string, unknown> = { value: "safe" };
    for (let index = 0; index < 40; index += 1) deep = { next: deep };
    const wide = Object.fromEntries(
      Array.from({ length: 5_001 }, (_, index) => [`key${index}`, index])
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => "MUSIC_U=must-not-run",
    });

    for (const value of [
      deep,
      wide,
      "x".repeat(128 * 1024 + 1),
      Array.from({ length: 5_001 }, () => null),
      circular,
      accessor,
    ]) {
      expect(classifySensitiveData(value)).toMatchObject({
        hasCredential: true,
      });
      expect(containsSensitiveData(value)).toBe(true);
    }
  });

  it("never treats account credentials as media capabilities", () => {
    expect(
      classifySensitiveData({
        url: "https://cdn.example/a.mp3?vkey=media-capability",
        nested: {
          Cookie: "MUSIC_U=account-credential",
          Authorization: "Bearer account-credential",
          api_token: "account-credential",
        },
      })
    ).toEqual({ hasCapability: true, hasCredential: true });

    expect(
      classifySensitiveData({
        url: "https://cdn.example/a.mp3?X-Amz-Signature=media-capability",
      })
    ).toEqual({ hasCapability: true, hasCredential: false });
  });

  it("classifies opaque audio and QQ POST URL resolution as capabilities", () => {
    expect(
      isCapabilityRequest(
        new Request(
          "https://music.example/music-api/bilibili/audio?url=cid%3A1"
        )
      )
    ).toBe(true);
    expect(
      isCapabilityRequest(
        new Request(
          "https://music.example/music-api/audio?source=joox&id=1&br=192"
        )
      )
    ).toBe(true);
    expect(
      isCapabilityRequest(
        new Request("https://music.example/music-api/qqmusic/proxy", {
          method: "POST",
        }),
        { type: "url" }
      )
    ).toBe(true);
    expect(
      isCapabilityRequest(
        new Request("https://music.example/music-api/qqmusic/proxy", {
          method: "POST",
        }),
        { type: "search" }
      )
    ).toBe(false);
  });
});
