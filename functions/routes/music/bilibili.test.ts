// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchBilibiliSearch: vi.fn(),
  createBilibiliAudioRequestBudget: vi.fn(),
  fetchBilibiliDashCandidates: vi.fn(),
  fetchBilibiliDurlSongUrls: vi.fn(),
  fetchBilibiliSearchCollections: vi.fn(),
  fetchBilibiliCollectionDetail: vi.fn(),
  proxyBilibiliAudio: vi.fn(),
  proxyBilibiliCover: vi.fn(),
}));

vi.mock("../../utils/music/bilibili-api", () => api);
vi.mock("../../utils/request-rate-limit", () => ({
  checkFixedWindowRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 119,
    retryAfterSeconds: 0,
  }),
  requestClientId: vi.fn().mockReturnValue("test-client"),
}));

import { bilibiliRoutes } from "./bilibili";

describe("Bilibili opaque audio capability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createBilibiliAudioRequestBudget.mockReturnValue({ budget: true });
    api.fetchBilibiliDashCandidates.mockResolvedValue({
      cid: 2164311,
      urls: [
        "https://upos-sz-mirrorcos.bilivideo.com/a.m4s?upsig=server-only&deadline=1",
      ],
    });
    api.fetchBilibiliDurlSongUrls.mockResolvedValue([]);
    api.proxyBilibiliAudio.mockResolvedValue(
      new Response("audio", {
        headers: {
          "Content-Type": "audio/mp4",
          "Cache-Control": "public, max-age=86400",
        },
      })
    );
    api.proxyBilibiliCover.mockResolvedValue(
      new Response("image", { headers: { "Content-Type": "image/jpeg" } })
    );
  });

  it.each([
    "/audio?bvid=BV1xx411c7mD",
    "/cover?url=https%3A%2F%2Fi0.hdslb.com%2Fa.jpg",
  ])("rejects cross-site media GET before provider work: %s", async (path) => {
    const response = await bilibiliRoutes.request(
      path,
      { headers: { "Sec-Fetch-Site": "cross-site" } },
      { oh_file_url: {}, APP_ORIGIN: "https://music.example" } as never
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(api.fetchBilibiliDashCandidates).not.toHaveBeenCalled();
    expect(api.proxyBilibiliCover).not.toHaveBeenCalled();
  });

  it("resolves the signed target server-side and forces private no-store", async () => {
    const response = await bilibiliRoutes.request(
      "/audio?bvid=BV1xx411c7mD&cid=2164311",
      undefined,
      { oh_file_url: {} } as never
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(api.fetchBilibiliDashCandidates).toHaveBeenCalledWith(
      "BV1xx411c7mD",
      2164311,
      { budget: true }
    );
    expect(api.proxyBilibiliAudio).toHaveBeenCalledWith(
      "BV1xx411c7mD",
      expect.stringContaining("upsig=server-only"),
      undefined,
      { budget: true }
    );
    expect(body).toBe("audio");
    expect(body).not.toContain("server-only");
  });

  it("rejects an invalid Range before resolving or fetching a media target", async () => {
    const response = await bilibiliRoutes.request(
      "/audio?bvid=BV1xx411c7mD&cid=2164311",
      { headers: { Range: "bytes=0-1,4-5" } },
      { oh_file_url: {} } as never
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(api.fetchBilibiliDashCandidates).not.toHaveBeenCalled();
    expect(api.proxyBilibiliAudio).not.toHaveBeenCalled();
  });

  it("does not copy an upstream status text capability", async () => {
    api.proxyBilibiliAudio.mockResolvedValueOnce(
      new Response("part", {
        status: 206,
        statusText: "upsig=status-text-capability-canary",
        headers: { "Content-Type": "audio/mp4" },
      })
    );

    const response = await bilibiliRoutes.request(
      "/audio?bvid=BV1xx411c7mD&cid=2164311",
      { headers: { Range: "bytes=0-3" } },
      { oh_file_url: {} } as never
    );

    expect(response.status).toBe(206);
    expect(response.statusText).not.toContain("capability-canary");
    expect(api.proxyBilibiliAudio).toHaveBeenCalledWith(
      "BV1xx411c7mD",
      expect.stringContaining("upsig=server-only"),
      "bytes=0-3",
      { budget: true }
    );
  });

  it("fails over from the primary DASH CDN to its provider backup", async () => {
    api.fetchBilibiliDashCandidates.mockResolvedValue({
      cid: 2164311,
      urls: [
        "https://primary.bilivideo.com/audio.m4s",
        "https://backup.bilivideo.com/audio.m4s",
      ],
    });
    api.proxyBilibiliAudio
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockResolvedValueOnce(
        new Response("backup audio", {
          headers: { "Content-Type": "audio/mp4" },
        })
      );

    const response = await bilibiliRoutes.request(
      "/audio?bvid=BV1xx411c7mD&cid=2164311",
      undefined,
      { oh_file_url: {} } as never
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("backup audio");
    expect(api.proxyBilibiliAudio).toHaveBeenNthCalledWith(
      2,
      "BV1xx411c7mD",
      "https://backup.bilivideo.com/audio.m4s",
      undefined,
      { budget: true }
    );
  });

  it("resolves durl lazily after every DASH CDN candidate fails", async () => {
    api.fetchBilibiliDashCandidates.mockResolvedValue({
      cid: 2164311,
      urls: [
        "https://primary.bilivideo.com/audio.m4s",
        "https://backup.bilivideo.com/audio.m4s",
      ],
    });
    api.fetchBilibiliDurlSongUrls.mockResolvedValue([
      "https://fallback.bilivideo.com/audio.mp4",
    ]);
    api.proxyBilibiliAudio
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockRejectedValueOnce(new Error("backup failed"))
      .mockResolvedValueOnce(
        new Response("durl audio", {
          headers: { "Content-Type": "audio/mp4" },
        })
      );

    const response = await bilibiliRoutes.request(
      "/audio?bvid=BV1xx411c7mD&cid=2164311",
      undefined,
      { oh_file_url: {} } as never
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("durl audio");
    expect(api.fetchBilibiliDurlSongUrls).toHaveBeenCalledWith(
      "BV1xx411c7mD",
      2164311,
      { budget: true }
    );
    expect(api.proxyBilibiliAudio).toHaveBeenNthCalledWith(
      3,
      "BV1xx411c7mD",
      "https://fallback.bilivideo.com/audio.mp4",
      undefined,
      { budget: true }
    );
    expect(
      api.fetchBilibiliDurlSongUrls.mock.invocationCallOrder[0]
    ).toBeGreaterThan(api.proxyBilibiliAudio.mock.invocationCallOrder[1]);
  });

  it("rejects a browser-supplied media URL before upstream resolution", async () => {
    const response = await bilibiliRoutes.request(
      `/audio?bvid=BV1xx411c7mD&url=${encodeURIComponent(
        "https://upos-sz-mirrorcos.bilivideo.com/a.m4s?upsig=browser-canary"
      )}`,
      undefined,
      { oh_file_url: {} } as never
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toContain("browser-canary");
    expect(api.fetchBilibiliDashCandidates).not.toHaveBeenCalled();
    expect(api.proxyBilibiliAudio).not.toHaveBeenCalled();
  });

  it("keeps the compatibility song-url response same-origin and private", async () => {
    const response = await bilibiliRoutes.request("/song-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bvid: "BV1xx411c7mD", cid: 2164311 }),
    });
    const payload = (await response.json()) as { url: string };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload.url).toBe(
      "/music-api/bilibili/audio?bvid=BV1xx411c7mD&cid=2164311"
    );
    expect(api.fetchBilibiliDashCandidates).not.toHaveBeenCalled();
  });
});
