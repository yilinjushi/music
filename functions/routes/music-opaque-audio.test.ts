// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const audio = vi.hoisted(() => ({
  proxyPrivateAudio: vi.fn(),
}));

vi.mock("@utils/proxy/audio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/proxy/audio")>();
  return { ...actual, proxyPrivateAudio: audio.proxyPrivateAudio };
});
vi.mock("../utils/request-rate-limit", () => ({
  checkFixedWindowRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 119,
    retryAfterSeconds: 0,
  }),
  requestClientId: vi.fn().mockReturnValue("test-client"),
}));

import { musicRoutes } from "./music";

describe("generic GD opaque audio", () => {
  const cache = { match: vi.fn(), put: vi.fn(), delete: vi.fn() };
  const cacheOpen = vi.fn().mockResolvedValue(cache);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("caches", { open: cacheOpen });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { source: "netease", id: "123" },
    { source: "joox", id: "ab+/cd==" },
    { source: "kuwo", id: "MUSIC_123" },
  ])(
    "returns an opaque compatibility URL for $source without resolving upstream",
    async ({ source, id }) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const response = await musicRoutes.request(
        `https://music.example/?${new URLSearchParams({
          types: "url",
          source,
          id,
          br: "999",
        }).toString()}`
      );
      const payload = (await response.json()) as { url: string };

      expect(response.status).toBe(200);
      expect(payload.url).toBe(
        `/music-api/audio?${new URLSearchParams({
          source,
          id,
          br: "999",
        }).toString()}`
      );
      expect(payload.url).not.toMatch(/vkey|deadline|signature/i);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(cacheOpen).not.toHaveBeenCalled();
    }
  );

  it("keeps the legacy _netease URL contract opaque without resolving upstream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        url: "https://m10.music.126.net/a.mp3?vkey=raw-capability-canary",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await musicRoutes.request(
      "https://music.example/?source=_netease&types=url&id=netrack_123&br=320"
    );
    const payload = (await response.json()) as {
      url: string;
      br: number;
      size: number;
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      url: "/music-api/netease/audio?id=123&br=320000",
      br: 320000,
      size: 0,
    });
    expect(JSON.stringify(payload)).not.toContain("raw-capability-canary");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheOpen).not.toHaveBeenCalled();
  });

  it.each(["url", "Url", "URL"])(
    "normalizes the legacy _netease capability type casing: %s",
    async (type) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await musicRoutes.request(
        `https://music.example/?source=_netease&types=${type}&id=123&br=192`
      );
      const payload = (await response.json()) as { url: string };

      expect(response.status).toBe(200);
      expect(payload.url).toBe("/music-api/netease/audio?id=123&br=192000");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    "source=_netease&types=url&id=1&id=2&br=320",
    "source=_netease&types=url&id=1&br=320&vkey=browser-canary",
    "source=_netease&type=url&types=url&id=1&br=320",
    "source=_netease&types=url&id=not-numeric&br=320",
  ])(
    "rejects an unsafe legacy _netease descriptor without resolution: %s",
    async (query) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await musicRoutes.request(
        `https://music.example/?${query}`
      );

      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("browser-canary");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(audio.proxyPrivateAudio).not.toHaveBeenCalled();
    }
  );

  it("resolves the signed URL only inside the server and preserves Range/206", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        url: "https://hk.stream.music.joox.com/a.mp3?vkey=generic-server-canary&deadline=1",
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    audio.proxyPrivateAudio.mockResolvedValue(
      new Response("part", {
        status: 206,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Range": "bytes 0-3/10",
          "Cache-Control": "private, no-store, max-age=0",
        },
      })
    );

    const response = await musicRoutes.request(
      "https://music.example/audio?source=joox&id=dHJhY2sx&br=320",
      { headers: { Range: "bytes=0-3" } },
      { oh_file_url: {} } as never
    );
    const body = await response.text();

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(audio.proxyPrivateAudio).toHaveBeenCalledWith(
      expect.stringContaining("vkey=generic-server-canary"),
      expect.objectContaining({ Referer: "https://www.joox.com/" }),
      "bytes=0-3"
    );
    expect(body).toBe("part");
    expect(body).not.toContain("generic-server-canary");
    expect(cacheOpen).not.toHaveBeenCalled();
  });

  it.each([
    "/audio?source=spotify&id=1&br=192",
    "/audio?source=joox&id=1&br=192&url=https%3A%2F%2Fevil.test",
    "/audio?source=joox&id=1&id=2&br=192",
    "/audio?source=joox&id=1%2F..%2Fsecret&br=192",
  ])(
    "rejects an unapproved descriptor before upstream resolution: %s",
    async (path) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const response = await musicRoutes.request(
        `https://music.example${path}`,
        undefined,
        { oh_file_url: {} } as never
      );

      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(audio.proxyPrivateAudio).not.toHaveBeenCalled();
    }
  );

  it("returns a fixed error when resolution fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("vkey=exception-capability-canary"))
    );
    const response = await musicRoutes.request(
      "https://music.example/audio?source=joox&id=dHJhY2sx&br=192",
      undefined,
      { oh_file_url: {} } as never
    );
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toBe('{"error":"Music upstream failed"}');
    expect(text).not.toContain("exception-capability-canary");
  });
});
