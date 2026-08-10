// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchQqPlaylistDetail: vi.fn(),
  fetchQqMusicSearch: vi.fn(),
  fetchQqMusicLyric: vi.fn(),
  fetchQqMusicUrl: vi.fn(),
  proxyQqMusicAudio: vi.fn(),
}));

vi.mock("../../utils/music/qqmusic-api", () => api);
vi.mock("../../utils/request-rate-limit", () => ({
  checkFixedWindowRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 119,
    retryAfterSeconds: 0,
  }),
  requestClientId: vi.fn().mockReturnValue("test-client"),
}));

import { qqmusicRoutes } from "./qqmusic";

describe("QQ Music capability response policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["320k", "128k", "m4a"])(
    "returns only a same-origin opaque URL for %s from POST type=url",
    async (quality) => {
      const response = await qqmusicRoutes.request("/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "url",
          songmid: "song-mid",
          quality,
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("private");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      const payload = (await response.json()) as { url: string };
      expect(payload.url).toBe(
        `/music-api/qqmusic/audio?songmid=song-mid&quality=${quality}`
      );
      expect(payload.url).not.toContain("vkey");
      expect(api.fetchQqMusicUrl).not.toHaveBeenCalled();
    }
  );

  it("marks invalid URL capability requests private before resolution", async () => {
    const response = await qqmusicRoutes.request("/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "url" }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(api.fetchQqMusicUrl).not.toHaveBeenCalled();
  });

  it("resolves the signed target server-side and preserves Range/206", async () => {
    api.fetchQqMusicUrl.mockResolvedValue({
      url: "https://isure6.stream.qqmusic.qq.com/a.m4a?vkey=server-canary&deadline=1",
    });
    api.proxyQqMusicAudio.mockResolvedValue(
      new Response("part", {
        status: 206,
        headers: {
          "Content-Type": "audio/mp4",
          "Content-Range": "bytes 0-3/10",
          "Cache-Control": "private, no-store, max-age=0",
        },
      })
    );

    const response = await qqmusicRoutes.request(
      "/audio?songmid=song-mid&quality=320k",
      { headers: { Range: "bytes=0-3" } },
      { oh_file_url: {} } as never
    );
    const body = await response.text();

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(api.fetchQqMusicUrl).toHaveBeenCalledWith("song-mid", "320k");
    expect(api.proxyQqMusicAudio).toHaveBeenCalledWith(
      expect.stringContaining("vkey=server-canary"),
      "bytes=0-3"
    );
    expect(body).toBe("part");
    expect(body).not.toContain("server-canary");
  });

  it("rejects injected query capability data before resolution", async () => {
    const response = await qqmusicRoutes.request(
      "/audio?songmid=song-mid&quality=320k&vkey=browser-canary",
      undefined,
      { oh_file_url: {} } as never
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("browser-canary");
    expect(api.fetchQqMusicUrl).not.toHaveBeenCalled();
    expect(api.proxyQqMusicAudio).not.toHaveBeenCalled();
  });

  it("uses a fixed error for URL resolution and stream setup failures", async () => {
    api.fetchQqMusicUrl.mockRejectedValue(
      new Error("vkey=exception-capability-canary")
    );
    const response = await qqmusicRoutes.request(
      "/audio?songmid=song-mid&quality=320k",
      undefined,
      { oh_file_url: {} } as never
    );
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toBe('{"error":"QQ Music audio upstream failed"}');
    expect(text).not.toContain("exception-capability-canary");
  });
});
