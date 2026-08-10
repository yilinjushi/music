import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchKuwoPlaylistDetail: vi.fn(),
}));
const rateLimit = vi.hoisted(() => vi.fn());

vi.mock("../../utils/music/kuwo-api", () => api);
vi.mock("../../utils/request-rate-limit", () => ({
  checkFixedWindowRateLimit: rateLimit,
  requestClientId: vi.fn().mockReturnValue("test-client"),
}));

import { kuwoRoutes } from "./kuwo";

const env = {
  APP_ORIGIN: "https://music.example",
  oh_file_url: {},
} as never;

describe("Kuwo public playlist route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({
      allowed: true,
      remaining: 11,
      retryAfterSeconds: 0,
    });
    api.fetchKuwoPlaylistDetail.mockResolvedValue({
      name: "bounded",
      coverUrl: "",
      trackCount: 0,
      songs: [],
    });
  });

  it("accepts a strict numeric ID", async () => {
    const response = await kuwoRoutes.request(
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
      env
    );

    expect(response.status).toBe(200);
    expect(api.fetchKuwoPlaylistDetail).toHaveBeenCalledWith("123");
  });

  it("rejects invalid fields and cross-site requests before upstream", async () => {
    for (const body of [
      { playlistId: "abc" },
      { playlistId: "1".repeat(21) },
      { playlistId: "123", extra: true },
    ]) {
      const response = await kuwoRoutes.request(
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
      const crossSite = await kuwoRoutes.request(
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
    expect(api.fetchKuwoPlaylistDetail).not.toHaveBeenCalled();
  });

  it("fails closed when the rate limiter is unavailable", async () => {
    rateLimit.mockRejectedValue(new Error("KV unavailable"));
    const response = await kuwoRoutes.request(
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
      env
    );

    expect(response.status).toBe(503);
    expect(api.fetchKuwoPlaylistDetail).not.toHaveBeenCalled();
  });
});
