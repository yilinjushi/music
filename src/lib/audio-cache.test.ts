import { afterEach, describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "@/types/music";
import {
  getAudioCacheJob,
  lookupAudioCache,
  startNeteasePlaylistCache,
} from "./audio-cache";

const track: MusicTrack = {
  id: "123",
  name: "Song",
  artist: ["Artist"],
  album: "Album",
  pic_id: "pic",
  url_id: "123",
  lyric_id: "123",
  source: "_netease",
};

afterEach(() => vi.restoreAllMocks());

describe("audio cache client", () => {
  it("returns a validated opaque cache path and sends no raw audio URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        path: "/music-api/cache/audio?key=" + "a".repeat(64),
        storedBr: 320,
      })
    );

    await expect(lookupAudioCache(track)).resolves.toBe(
      "/music-api/cache/audio?key=" + "a".repeat(64)
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      source: "_netease",
      id: "123",
      urlId: "123",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
  });

  it("treats a cache miss or malformed path as a provider fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("miss", { status: 404 })
    );
    await expect(lookupAudioCache(track)).resolves.toBeNull();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ path: "https://media.example/song.mp3" })
    );
    await expect(lookupAudioCache(track)).resolves.toBeNull();
  });

  it("starts and reads a cache job through same-origin requests", async () => {
    const job = {
      jobId: "c".repeat(32),
      state: "running",
      total: 364,
      processed: 4,
      cached: 4,
      skipped: 0,
      failed: 0,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(job));

    await expect(startNeteasePlaylistCache("7")).resolves.toEqual(job);
    await expect(getAudioCacheJob(job.jobId)).resolves.toEqual(job);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      playlistId: "7",
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      `/jobs/${job.jobId}`
    );
  });
});
