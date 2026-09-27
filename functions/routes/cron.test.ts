// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { cronRoutes } from "./cron";

describe("scheduled audio cache sync", () => {
  const cache = {
    lookup: vi.fn(),
    serve: vi.fn(),
    startNeteasePlaylistJob: vi.fn(),
    cacheNeteaseTrack: vi.fn(),
    syncNeteasePlaylist: vi.fn(),
    getPlaylistStatus: vi.fn(),
    getJob: vi.fn(),
  };
  const kv = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn(),
    delete: vi.fn(),
  };
  const env = {
    AUDIO_CACHE: cache,
    CRON_SECRET: "s".repeat(32),
    oh_file_url: kv,
  } as never;
  const call = (authorization?: string) =>
    cronRoutes.request(
      "https://music.example/audio-cache",
      {
        method: "POST",
        headers: authorization ? { Authorization: authorization } : {},
      },
      env
    );

  it("rejects callers without the shared secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(cache.syncNeteasePlaylist).not.toHaveBeenCalled();
  });

  it("stays idle until the app has registered a target", async () => {
    const response = await call(`Bearer ${"s".repeat(32)}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ state: "idle" });
  });
});
