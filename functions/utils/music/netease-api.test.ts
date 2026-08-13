import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPlaylistDetail,
  NETEASE_PLAYLIST_MAX_TRACKS,
  NETEASE_PLAYLIST_TRACK_BATCH_SIZE,
} from "./netease-api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server NetEase playlist budget", () => {
  it("rejects invalid IDs before opening an upstream request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(getPlaylistDetail("../../500", "")).rejects.toBeInstanceOf(
      TypeError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized trackIds after only the detail request", async () => {
    const trackIds = Array.from(
      { length: NETEASE_PLAYLIST_MAX_TRACKS + 1 },
      (_, index) => ({ id: index + 1 })
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ playlist: { id: 7, trackIds } }), {
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(getPlaylistDetail("7", "")).rejects.toThrow(
      /safe track limit/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a truncated detail whose reported count exceeds the cap", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          playlist: {
            id: 7,
            trackCount: NETEASE_PLAYLIST_MAX_TRACKS + 1,
            trackIds: [{ id: 1 }],
          },
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(getPlaylistDetail("7", "")).rejects.toThrow(
      /safe track limit/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns visible tracks when unavailable songs make trackCount larger", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            playlist: {
              id: 7,
              name: "partially visible",
              trackCount: 2,
              trackIds: [{ id: 1 }],
            },
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ songs: [{ id: 1, name: "Visible" }] }), {
          headers: { "Content-Type": "application/json" },
        })
      );

    const detail = await getPlaylistDetail("7", "");

    expect(detail.trackCount).toBe(2);
    expect(detail.tracks).toEqual([{ id: 1, name: "Visible" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses fixed 100-track batches under the total request cap", async () => {
    const trackCount = NETEASE_PLAYLIST_TRACK_BATCH_SIZE * 2 + 50;
    const trackIds = Array.from({ length: trackCount }, (_, index) => ({
      id: index + 1,
    }));
    let call = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({ playlist: { id: 7, name: "bounded", trackIds } }),
            { headers: { "Content-Type": "application/json" } }
          );
        }
        const batchCount = call < 4 ? NETEASE_PLAYLIST_TRACK_BATCH_SIZE : 50;
        return new Response(
          JSON.stringify({
            songs: Array.from({ length: batchCount }, (_, index) => ({
              id: (call - 2) * NETEASE_PLAYLIST_TRACK_BATCH_SIZE + index + 1,
              name: `Song ${index}`,
            })),
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      });

    const detail = await getPlaylistDetail("neplaylist_7", "");

    expect(detail.tracks).toHaveLength(trackCount);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("loads independent song-detail batches concurrently", async () => {
    const trackIds = Array.from(
      { length: NETEASE_PLAYLIST_TRACK_BATCH_SIZE + 1 },
      (_, index) => ({ id: index + 1 })
    );
    let pendingBatches = 0;
    let maxPendingBatches = 0;
    let batchCall = 0;
    vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ playlist: { id: 7, trackIds } }), {
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockImplementation(async (_input, init) => {
        batchCall += 1;
        const currentBatch = batchCall;
        pendingBatches += 1;
        maxPendingBatches = Math.max(maxPendingBatches, pendingBatches);
        await Promise.resolve();
        pendingBatches -= 1;
        const params = new URLSearchParams(String(init?.body));
        const encryptedRequest = params.get("params");
        const batchSize = currentBatch === 1 ? 100 : 1;
        expect(encryptedRequest).toBeTruthy();
        return new Response(
          JSON.stringify({
            songs: Array.from({ length: batchSize }, (_, index) => ({
              id: currentBatch === 1 ? index + 1 : 101,
              name: `Song ${index + 1}`,
            })),
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      });

    const detail = await getPlaylistDetail("7", "");

    expect(detail.tracks).toHaveLength(101);
    expect(maxPendingBatches).toBe(2);
  });

  it("rejects extra or unrelated songs returned for a bounded batch", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            playlist: { id: 7, trackCount: 1, trackIds: [{ id: 1 }] },
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            songs: [
              { id: 1, name: "Expected" },
              { id: 999, name: "Injected" },
            ],
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );

    await expect(getPlaylistDetail("7", "")).rejects.toThrow(/batch|identity/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate identities even when the response length fits", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            playlist: {
              id: 7,
              trackCount: 2,
              trackIds: [{ id: 1 }, { id: 2 }],
            },
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            songs: [
              { id: 1, name: "First" },
              { id: 1, name: "Duplicate" },
            ],
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );

    await expect(getPlaylistDetail("7", "")).rejects.toThrow(/identity/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
