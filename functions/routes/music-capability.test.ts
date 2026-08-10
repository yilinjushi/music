// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const qqApi = vi.hoisted(() => ({
  fetchQqPlaylistDetail: vi.fn(),
  fetchQqMusicSearch: vi.fn(),
  fetchQqMusicLyric: vi.fn(),
  fetchQqMusicUrl: vi.fn(),
  proxyQqMusicAudio: vi.fn(),
}));

vi.mock("../utils/music/qqmusic-api", () => qqApi);
vi.mock("../utils/request-rate-limit", () => ({
  checkFixedWindowRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 119,
    retryAfterSeconds: 0,
  }),
  requestClientId: vi.fn().mockReturnValue("test-client"),
}));

import { musicRoutes } from "./music";

describe("music router body capability classification", () => {
  const cache = {
    match: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
  const open = vi.fn().mockResolvedValue(cache);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("caches", { open });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns QQ POST type=url privately without touching Cache Storage", async () => {
    const response = await musicRoutes.request(
      "https://music.example/qqmusic/proxy",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "url",
          songmid: "song-mid",
          quality: "320k",
        }),
      }
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(text).toContain(
      "/music-api/qqmusic/audio?songmid=song-mid&quality=320k"
    );
    expect(text).not.toContain("vkey");
    expect(qqApi.fetchQqMusicUrl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it.each([
    ["Cookie", "MUSIC_U=credential-canary"],
    ["Authorization", "Bearer credential-canary"],
    ["api_token", "credential-canary"],
    ["account", { credential: "credential-canary" }],
  ])(
    "rejects a %s credential even beside an allowed media capability",
    async (field, credential) => {
      qqApi.fetchQqMusicUrl.mockResolvedValue({
        url: "https://stream.qqmusic.qq.com/a.m4a?vkey=allowed-capability",
        [field]: credential,
      });

      const response = await musicRoutes.request(
        "https://music.example/qqmusic/audio?songmid=song-mid&quality=320k",
        undefined,
        { oh_file_url: {} } as never
      );
      const text = await response.text();

      expect(response.status).toBe(502);
      expect(text).toBe('{"error":"Music upstream failed"}');
      expect(text).not.toContain("credential-canary");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(cache.put).not.toHaveBeenCalled();
    }
  );

  it("rejects a generic upstream credential canary with a fixed 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          url: "https://cdn.example/a.mp3?vkey=allowed-capability",
          cookie: "MUSIC_U=generic-credential-canary",
        })
      )
    );

    const response = await musicRoutes.request(
      "https://music.example/audio?source=netease&id=123&br=192",
      undefined,
      { oh_file_url: {} } as never
    );
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toBe('{"error":"Music upstream failed"}');
    expect(text).not.toContain("generic-credential-canary");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(cache.put).not.toHaveBeenCalled();
  });
});
