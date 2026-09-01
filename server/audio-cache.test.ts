// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const netease = vi.hoisted(() => ({
  getPlaylistDetail: vi.fn(),
  getSongUrl: vi.fn(),
}));
const audio = vi.hoisted(() => ({
  proxyPrivateAudio: vi.fn(),
}));
const shared = vi.hoisted(() => ({
  fetchUpstreamWithDeadline: vi.fn(),
}));

vi.mock("../functions/utils/music/netease-api", () => netease);
vi.mock("../functions/utils/proxy/audio", () => audio);
vi.mock("@otter-music/shared", async () => {
  const actual = await vi.importActual<typeof import("@otter-music/shared")>(
    "@otter-music/shared"
  );
  return { ...actual, fetchUpstreamWithDeadline: shared.fetchUpstreamWithDeadline };
});

import { VpsAudioCache } from "./audio-cache";

const song = (id: number, name = `Song ${id}`) => ({
  id,
  name,
  ar: [{ id: 10, name: "Artist" }],
  al: { id: 20, name: "Album", picUrl: "" },
  dt: 0,
});

describe("VpsAudioCache", () => {
  let directory = "";
  let cache: VpsAudioCache;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "otter-audio-cache-"));
    cache = new VpsAudioCache(directory);
    vi.clearAllMocks();
    shared.fetchUpstreamWithDeadline.mockImplementation(
      async (_input, _init, read) =>
        read(
          new Response("[]", {
            headers: { "Content-Type": "application/json" },
          })
        )
    );
  });

  afterEach(async () => {
    cache.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("downloads a track, exposes an opaque lookup path, and serves ranges", async () => {
    netease.getPlaylistDetail.mockResolvedValue({
      trackCount: 1,
      hasMore: false,
      nextOffset: 1,
      tracks: [song(1)],
    });
    netease.getSongUrl.mockResolvedValue({
      data: { data: [{ url: "https://media.example/song-1.mp3" }] },
    });
    audio.proxyPrivateAudio.mockResolvedValue(
      new Response(new TextEncoder().encode("0123456789"), {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": "10",
        },
      })
    );

    const started = await cache.startNeteasePlaylistJob("7", "MUSIC_U=hidden");
    await vi.waitFor(() => {
      expect(cache.getJob(started.jobId)?.state).toBe("completed");
    });

    expect(cache.getJob(started.jobId)).toMatchObject({
      total: 1,
      processed: 1,
      cached: 1,
      failed: 0,
    });
    const lookup = await cache.lookup({ source: "_netease", id: "1" });
    expect(lookup?.path).toMatch(
      /^\/music-api\/cache\/audio\?key=[a-f0-9]{64}$/
    );
    expect(lookup?.storedBr).toBe(320);

    const key = lookup!.path.split("key=")[1]!;
    const full = await cache.serve(key);
    expect(full?.status).toBe(200);
    expect(await full?.text()).toBe("0123456789");

    const partial = await cache.serve(key, "bytes=2-5");
    expect(partial?.status).toBe(206);
    expect(await partial?.text()).toBe("2345");
    expect(partial?.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(partial?.headers.get("accept-ranges")).toBe("bytes");
  });

  it("falls back from 320 to 192 and never requests a lower cache quality", async () => {
    netease.getPlaylistDetail.mockResolvedValue({
      trackCount: 1,
      hasMore: false,
      nextOffset: 1,
      tracks: [song(2)],
    });
    netease.getSongUrl
      .mockResolvedValueOnce({ data: { data: [] } })
      .mockResolvedValueOnce({
        data: { data: [{ url: "https://media.example/song-2.mp3" }] },
      });
    audio.proxyPrivateAudio.mockResolvedValue(
      new Response(new Uint8Array(100), {
        headers: { "Content-Type": "audio/mpeg", "Content-Length": "100" },
      })
    );

    const started = await cache.startNeteasePlaylistJob("8", "MUSIC_U=hidden");
    await vi.waitFor(() => {
      expect(cache.getJob(started.jobId)?.state).toBe("completed");
    });

    expect(netease.getSongUrl).toHaveBeenNthCalledWith(
      1,
      "2",
      320_000,
      "MUSIC_U=hidden"
    );
    expect(netease.getSongUrl).toHaveBeenNthCalledWith(
      2,
      "2",
      192_000,
      "MUSIC_U=hidden"
    );
    const lookup = await cache.lookup({ source: "netease", id: "2" });
    expect(lookup?.storedBr).toBe(192);
  });

  it("skips a track already present in the persistent cache", async () => {
    netease.getPlaylistDetail.mockResolvedValue({
      trackCount: 1,
      hasMore: false,
      nextOffset: 1,
      tracks: [song(3)],
    });
    netease.getSongUrl.mockResolvedValue({
      data: { data: [{ url: "https://media.example/song-3.mp3" }] },
    });
    audio.proxyPrivateAudio.mockResolvedValue(
      new Response(new Uint8Array(100), {
        headers: { "Content-Type": "audio/mpeg", "Content-Length": "100" },
      })
    );

    const first = await cache.startNeteasePlaylistJob("9", "MUSIC_U=hidden");
    await vi.waitFor(() => expect(cache.getJob(first.jobId)?.state).toBe("completed"));
    const callsAfterFirst = netease.getSongUrl.mock.calls.length;

    const second = await cache.startNeteasePlaylistJob("9", "MUSIC_U=hidden");
    await vi.waitFor(() => expect(cache.getJob(second.jobId)?.state).toBe("completed"));
    expect(cache.getJob(second.jobId)).toMatchObject({ skipped: 1, cached: 0 });
    expect(netease.getSongUrl).toHaveBeenCalledTimes(callsAfterFirst);
  });
});
