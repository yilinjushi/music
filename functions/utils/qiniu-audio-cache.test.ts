import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/hono";
import { createQiniuAudioCache } from "./qiniu-audio-cache";

const netease = vi.hoisted(() => ({
  getPlaylistDetail: vi.fn(),
  getSongUrl: vi.fn(),
}));

vi.mock("./music/netease-api", () => ({
  NETEASE_PLAYLIST_MAX_TOTAL_TRACKS: 20_000,
  NETEASE_PLAYLIST_PAGE_SIZE: 100,
  getPlaylistDetail: netease.getPlaylistDetail,
  getSongUrl: netease.getSongUrl,
}));

function createKv() {
  return {
    get: vi.fn(),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function createEnv() {
  const kv = createKv();
  return {
    env: {
      APP_ORIGIN: "https://music.example",
      oh_file_url: kv,
      SESSION_KV: createKv(),
      NETEASE_SESSION_HMAC_SECRET: "hmac-secret",
      NETEASE_CREDENTIAL_ENC_KEY: "encryption-secret",
      QINIU_ACCESS_KEY: "access-key",
      QINIU_SECRET_KEY: "secret-key",
      QINIU_AUDIO_CACHE_BUCKET: "music-cache-overseas",
      QINIU_AUDIO_CACHE_REGION: "as0",
      QINIU_AUDIO_CACHE_DOMAIN: "http://music-cache.80007001.xyz",
      QINIU_AUDIO_CACHE_PREFIX: "otter-music-cache/v1",
    } as unknown as Env,
    kv,
  };
}

describe("Qiniu audio cache adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    netease.getPlaylistDetail.mockReset();
    netease.getSongUrl.mockReset();
  });

  it("stays disabled when its required configuration is incomplete", () => {
    const kv = createKv();
    const env = {
      APP_ORIGIN: "https://music.example",
      oh_file_url: kv,
      SESSION_KV: createKv(),
    } as unknown as Env;

    expect(createQiniuAudioCache(env, vi.fn())).toBeNull();
  });

  it("looks up a ready object using an opaque cache key", async () => {
    const { env, kv } = createEnv();
    kv.get.mockResolvedValue({
      version: 1,
      state: "ready",
      targetKey: "netease:123",
      objectKey: "otter-music-cache/v1/object.audio",
      storedBr: 192,
      contentType: "audio/mpeg",
      createdAt: Date.now(),
    });
    const cache = createQiniuAudioCache(env, vi.fn());

    const result = await cache?.lookup({
      source: "_netease",
      id: "123",
      urlId: "123",
    });

    expect(result?.path).toMatch(
      /^\/music-api\/cache\/audio\?key=[a-f0-9]{64}$/
    );
    expect(result?.storedBr).toBe(192);
  });

  it("serves a private object with a bounded range response", async () => {
    const { env, kv } = createEnv();
    const cacheKey = "a".repeat(64);
    kv.get.mockResolvedValue({
      version: 1,
      state: "ready",
      targetKey: "netease:123",
      objectKey: "otter-music-cache/v1/object.audio",
      storedBr: 320,
      contentType: "audio/mpeg",
      createdAt: Date.now(),
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x", {
        status: 206,
        headers: {
          "Content-Type": "audio/mpeg; charset=utf-8",
          "Content-Length": "1",
          "Content-Range": "bytes 0-0/123",
        },
      })
    );
    const cache = createQiniuAudioCache(env, vi.fn());

    const response = await cache?.serve(cacheKey, "bytes=0-0");

    expect(response?.status).toBe(206);
    expect(response?.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response?.headers.get("Content-Range")).toBe("bytes 0-0/123");
    expect(response?.headers.get("Cache-Control")).toBe(
      "private, max-age=86400"
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^http:\/\/music-cache\.80007001\.xyz\/otter-music-cache\/v1\/object\.audio\?e=\d+&token=/
      ),
      { headers: { Range: "bytes=0-0" } }
    );
  });

  it("records and runs a playlist job through the supplied waitUntil hook", async () => {
    const { env, kv } = createEnv();
    netease.getPlaylistDetail.mockResolvedValue({
      tracks: [],
      trackIds: [],
      hasMore: false,
      nextOffset: 0,
      trackCount: 0,
    });
    let background: Promise<unknown> | undefined;
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      background = promise;
    });
    const cache = createQiniuAudioCache(env, waitUntil);

    const job = await cache?.startNeteasePlaylistJob(
      "neplaylist_123",
      "MUSIC_U=x"
    );

    expect(["queued", "running"]).toContain(job?.state);
    expect(waitUntil).toHaveBeenCalledOnce();
    await background;
    const jobWrites = kv.put.mock.calls.filter(([key]) =>
      String(key).startsWith("audio-cache-job:v1:")
    );
    expect(jobWrites.length).toBeGreaterThanOrEqual(2);
    expect(String(jobWrites.at(-1)?.[1])).toContain('"state":"completed"');
  });

  describe("single NetEase track caching", () => {
    const track = { id: "123", name: "Song", artist: ["Artist"] };

    it("queues one background fetch and releases its in-flight lock", async () => {
      const { env, kv } = createEnv();
      kv.get.mockResolvedValue(null);
      netease.getSongUrl.mockResolvedValue(null);
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
      let background: Promise<unknown> | undefined;
      const waitUntil = vi.fn((promise: Promise<unknown>) => {
        background = promise;
      });
      const cache = createQiniuAudioCache(env, waitUntil);

      await expect(cache?.cacheNeteaseTrack(track, "MUSIC_U=x")).resolves.toBe(
        "queued"
      );
      expect(waitUntil).toHaveBeenCalledOnce();
      const lockKey = kv.put.mock.calls.find(([key]) =>
        String(key).startsWith("audio-cache-track:v1:")
      )?.[0];
      expect(lockKey).toBeDefined();
      await background;
      expect(netease.getSongUrl).toHaveBeenCalledWith(
        "123",
        320_000,
        "MUSIC_U=x"
      );
      expect(kv.delete).toHaveBeenCalledWith(lockKey);
    });

    it("skips tracks that are already stored or already being stored", async () => {
      const { env, kv } = createEnv();
      const waitUntil = vi.fn();
      const cache = createQiniuAudioCache(env, waitUntil);

      kv.get.mockResolvedValueOnce({
        version: 1,
        state: "ready",
        targetKey: "netease:123",
        objectKey: "otter-music-cache/v1/abc",
        storedBr: 320,
      });
      await expect(cache?.cacheNeteaseTrack(track, "")).resolves.toBe("cached");

      kv.get.mockResolvedValueOnce(null).mockResolvedValueOnce("1");
      await expect(cache?.cacheNeteaseTrack(track, "")).resolves.toBe(
        "pending"
      );
      expect(waitUntil).not.toHaveBeenCalled();
    });

    it("rejects non-NetEase identifiers", async () => {
      const { env } = createEnv();
      const cache = createQiniuAudioCache(env, vi.fn());
      await expect(
        cache?.cacheNeteaseTrack({ ...track, id: "abc" }, "")
      ).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe("bounded playlist sync", () => {
    function playlistWith(id: number) {
      netease.getPlaylistDetail.mockResolvedValue({
        tracks: [{ id, name: "Song", ar: [{ name: "Artist" }], dt: 180_000 }],
        trackIds: [{ id }],
        hasMore: false,
        nextOffset: 1,
        trackCount: 1,
      });
    }

    function memoryKv(kv: ReturnType<typeof createKv>) {
      const store = new Map<string, string>();
      kv.get.mockImplementation(
        async (key: string, options?: { type?: string }) => {
          const value = store.get(key) ?? null;
          return options?.type === "json" && value ? JSON.parse(value) : value;
        }
      );
      kv.put.mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
      });
      kv.delete.mockImplementation(async (key: string) => {
        store.delete(key);
      });
      return store;
    }

    it("submits a full-length source without waiting, then marks it ready", async () => {
      const { env, kv } = createEnv();
      const store = memoryKv(kv);
      playlistWith(123);
      netease.getSongUrl.mockResolvedValue({
        data: {
          data: [
            { url: "https://m701.music.126.net/a.mp3", freeTrialInfo: null },
          ],
        },
      });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(Response.json({ id: "task-1" }));
      const cache = createQiniuAudioCache(env, vi.fn())!;

      const first = await cache.syncNeteasePlaylist(
        "neplaylist_1",
        "MUSIC_U=x"
      );
      expect(first).toMatchObject({
        total: 1,
        submitted: 1,
        pending: 1,
        ready: 0,
      });
      expect(
        [...store.keys()].some((key) =>
          key.startsWith("audio-cache-pending:v1:")
        )
      ).toBe(true);

      // Pretend the submit happened long enough ago, then the probe finds it.
      for (const [key, value] of store) {
        if (key.startsWith("audio-cache-pending:v1:")) {
          store.set(
            key,
            JSON.stringify({ ...JSON.parse(value), submittedAt: 0 })
          );
        }
      }
      fetchMock.mockResolvedValueOnce(
        new Response("x", {
          status: 206,
          headers: { "Content-Type": "audio/mpeg" },
        })
      );
      const second = await cache.syncNeteasePlaylist(
        "neplaylist_1",
        "MUSIC_U=x"
      );
      expect(second).toMatchObject({ ready: 1, pending: 0 });
      expect(
        [...store.keys()].some((key) => key.startsWith("audio-cache:v1:"))
      ).toBe(true);
    });

    it("never caches a NetEase trial clip and reports songs with no source", async () => {
      const { env, kv } = createEnv();
      memoryKv(kv);
      playlistWith(456);
      netease.getSongUrl.mockResolvedValue({
        data: {
          data: [
            {
              url: "https://m701.music.126.net/trial.mp3",
              freeTrialInfo: { start: 0, end: 30 },
            },
          ],
        },
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ data: [] })
      );
      const cache = createQiniuAudioCache(env, vi.fn())!;

      let result = await cache.syncNeteasePlaylist("neplaylist_1", "MUSIC_U=x");
      expect(result.submitted).toBe(0);
      for (let round = 0; round < 2; round += 1) {
        result = await cache.syncNeteasePlaylist("neplaylist_1", "MUSIC_U=x");
      }
      expect(result.unavailable).toEqual(["456"]);
      await expect(
        cache.getPlaylistStatus("neplaylist_1")
      ).resolves.toMatchObject({
        unavailable: ["456"],
      });
    });
  });
});
