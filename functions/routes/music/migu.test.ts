// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchMiguPlaylistDetail: vi.fn(),
  fetchMiguSearch: vi.fn(),
  fetchMiguSongUrl: vi.fn(),
  isMiguPlaylistShortLink: vi.fn(),
  resolveMiguShortPlaylistId: vi.fn(),
  proxyMiguAudio: vi.fn(),
}));
const rateLimit = vi.hoisted(() => vi.fn());

vi.mock("../../utils/music/migu-api", () => api);
vi.mock("../../utils/request-rate-limit", () => ({
  checkFixedWindowRateLimit: rateLimit,
  requestClientId: vi.fn().mockReturnValue("test-client"),
}));

import { miguRoutes } from "./migu";

describe("Migu opaque audio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({
      allowed: true,
      remaining: 119,
      retryAfterSeconds: 0,
    });
  });

  it("returns an opaque compatibility URL without resolving upstream", async () => {
    const response = await miguRoutes.request("/song-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        copyrightId: "copyright-1",
        contentId: "content-1",
        br: 320,
      }),
    });
    const payload = (await response.json()) as { url: string };

    expect(response.status).toBe(200);
    expect(payload.url).toBe(
      "/music-api/migu/audio?copyrightId=copyright-1&contentId=content-1&br=320"
    );
    expect(payload.url).not.toMatch(/key|tim|signature/i);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(api.fetchMiguSongUrl).not.toHaveBeenCalled();
  });

  it("resolves a signed URL server-side and preserves Range/206", async () => {
    api.fetchMiguSongUrl.mockResolvedValue(
      "https://freetyst.nf.migu.cn/a.mp3?Key=server-canary&Tim=1"
    );
    api.proxyMiguAudio.mockResolvedValue(
      new Response("part", {
        status: 206,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Range": "bytes 0-3/10",
          "Cache-Control": "private, no-store, max-age=0",
        },
      })
    );

    const response = await miguRoutes.request(
      "/audio?copyrightId=copyright-1&contentId=content-1&br=320",
      { headers: { Range: "bytes=0-3" } },
      { oh_file_url: {} } as never
    );
    const body = await response.text();

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(api.fetchMiguSongUrl).toHaveBeenCalledWith(
      "copyright-1",
      "content-1",
      320
    );
    expect(api.proxyMiguAudio).toHaveBeenCalledWith(
      expect.stringContaining("Key=server-canary"),
      "bytes=0-3"
    );
    expect(body).toBe("part");
    expect(body).not.toContain("server-canary");
  });

  it("rejects injected query data before resolution", async () => {
    const response = await miguRoutes.request(
      "/audio?copyrightId=copyright-1&contentId=content-1&br=320&Key=browser-canary",
      undefined,
      { oh_file_url: {} } as never
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("browser-canary");
    expect(api.fetchMiguSongUrl).not.toHaveBeenCalled();
    expect(api.proxyMiguAudio).not.toHaveBeenCalled();
  });

  it("returns a fixed error when resolving or opening the stream fails", async () => {
    api.fetchMiguSongUrl.mockRejectedValue(
      new Error("Key=exception-capability-canary")
    );
    const response = await miguRoutes.request(
      "/audio?copyrightId=copyright-1&contentId=content-1&br=320",
      undefined,
      { oh_file_url: {} } as never
    );
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toBe('{"error":"Migu audio upstream failed"}');
    expect(text).not.toContain("exception-capability-canary");
  });

  it("validates playlist IDs, origin metadata, and exact fields", async () => {
    const env = {
      APP_ORIGIN: "https://music.example",
      oh_file_url: {},
    } as never;
    for (const body of [
      { playlistId: "" },
      { playlistId: "abc" },
      { playlistId: "1".repeat(21) },
      { playlistId: "123", extra: true },
    ]) {
      const response = await miguRoutes.request(
        "/playlist",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://music.example",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify(body),
        },
        env
      );
      expect(response.status).toBe(400);
    }

    for (const headers of [
      { "Content-Type": "application/json" },
      { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
      {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "same-origin",
      },
    ]) {
      const crossSite = await miguRoutes.request(
        "/playlist",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ playlistId: "123" }),
        },
        env
      );
      expect(crossSite.status).toBe(403);
    }
    expect(api.fetchMiguPlaylistDetail).not.toHaveBeenCalled();
  });

  it("fails closed when the playlist limiter is unavailable", async () => {
    rateLimit.mockRejectedValue(new Error("KV unavailable"));
    const response = await miguRoutes.request(
      "/playlist",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://music.example",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ playlistId: "123" }),
      },
      { APP_ORIGIN: "https://music.example", oh_file_url: {} } as never
    );

    expect(response.status).toBe(503);
    expect(api.fetchMiguPlaylistDetail).not.toHaveBeenCalled();
  });

  it("rejects unbounded or coerced search fields", async () => {
    for (const body of [
      { keyword: "x".repeat(101), page: 1, rows: 20 },
      { keyword: "valid", page: "1", rows: 20 },
      { keyword: "valid", page: 101, rows: 20 },
      { keyword: "valid", page: 1, rows: 51 },
    ]) {
      const response = await miguRoutes.request(
        "/search",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://music.example",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify(body),
        },
        { APP_ORIGIN: "https://music.example", oh_file_url: {} } as never
      );
      expect(response.status).toBe(400);
    }
    expect(api.fetchMiguSearch).not.toHaveBeenCalled();
  });
});
