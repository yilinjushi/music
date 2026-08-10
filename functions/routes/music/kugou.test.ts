import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchKugouPlaylistDetail: vi.fn(),
  resolveKugouShortUrl: vi.fn(),
}));
const rateLimit = vi.hoisted(() => vi.fn());

vi.mock("../../utils/music/kugou-api", () => api);
vi.mock("../../utils/request-rate-limit", () => ({
  checkFixedWindowRateLimit: rateLimit,
  requestClientId: vi.fn().mockReturnValue("test-client"),
}));

import { kugouRoutes } from "./kugou";

const request = (url: string) =>
  kugouRoutes.request(
    "/resolve-shortlink",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://music.example",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ url }),
    },
    { APP_ORIGIN: "https://music.example", oh_file_url: {} } as never
  );

describe("Kugou short-link policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({
      allowed: true,
      remaining: 11,
      retryAfterSeconds: 0,
    });
  });

  it.each([
    "http://t1.kugou.com/abc",
    "https://127.0.0.1/secret",
    "https://example.com/secret",
    "https://t1.kugou.com.evil.invalid/secret",
    "https://user:pass@t1.kugou.com/secret",
  ])("rejects an unapproved fetch target: %s", async (url) => {
    const response = await request(url);
    expect(response.status).toBe(400);
    expect(api.resolveKugouShortUrl).not.toHaveBeenCalled();
  });

  it("accepts only the reviewed HTTPS short-link host pattern", async () => {
    api.resolveKugouShortUrl.mockResolvedValue(
      "https://www.kugou.com/songlist/gcid_example/"
    );
    const url = "https://t1.kugou.com/AbCd";
    const response = await request(url);
    expect(response.status).toBe(200);
    expect(api.resolveKugouShortUrl).toHaveBeenCalledWith(url);
  });

  it("strictly validates playlist IDs and request source", async () => {
    const env = {
      APP_ORIGIN: "https://music.example",
      oh_file_url: {},
    } as never;
    for (const body of [
      { playlistId: "abc" },
      { playlistId: "1".repeat(21) },
      { playlistId: "gcid_" },
      { playlistId: "123", extra: true },
    ]) {
      const response = await kugouRoutes.request(
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
      const crossSite = await kugouRoutes.request(
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
    expect(api.fetchKugouPlaylistDetail).not.toHaveBeenCalled();
  });

  it("fails closed when playlist rate limiting is unavailable", async () => {
    rateLimit.mockRejectedValue(new Error("KV unavailable"));
    const response = await kugouRoutes.request(
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
    expect(api.fetchKugouPlaylistDetail).not.toHaveBeenCalled();
  });
});
