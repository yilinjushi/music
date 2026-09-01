import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPlaylistDetail,
  NETEASE_PLAYLIST_MAX_REQUESTS,
  NETEASE_PLAYLIST_MAX_TOTAL_TRACKS,
  NETEASE_PLAYLIST_MAX_TRACKS,
  NETEASE_PLAYLIST_PAGE_SIZE,
  NETEASE_PLAYLIST_TRACK_BATCH_SIZE,
  NETEASE_PLAYLIST_WALL_CLOCK_MS,
} from "./netease-api";

afterEach(() => {
  vi.useRealTimers();
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

  it("retries one transient server failure and then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ playlist: { id: 7, trackIds: [{ id: 1 }] } }),
          { headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ songs: [{ id: 1, name: "Recovered" }] }),
          {
            headers: { "Content-Type": "application/json" },
          }
        )
      );

    const detail = await getPlaylistDetail("7", "");

    expect(detail.tracks).toEqual([{ id: 1, name: "Recovered" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries one transient network failure and then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ playlist: { id: 7, trackIds: [{ id: 1 }] } }),
          { headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ songs: [{ id: 1, name: "Recovered" }] }),
          {
            headers: { "Content-Type": "application/json" },
          }
        )
      );

    await expect(getPlaylistDetail("7", "")).resolves.toMatchObject({
      tracks: [{ id: 1, name: "Recovered" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a transient failure only once", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response("temporary", { status: 503 })
      );

    await expect(getPlaylistDetail("7", "")).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry deterministic client errors", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("denied", { status: 401 }));

    await expect(getPlaylistDetail("7", "")).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry malformed successful responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("{", {
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(getPlaylistDetail("7", "")).rejects.toBeInstanceOf(
      SyntaxError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps retries inside the shared request and wall-clock budgets", async () => {
    vi.useFakeTimers();
    const trackIds = Array.from(
      { length: NETEASE_PLAYLIST_MAX_TRACKS },
      (_, index) => ({ id: index + 1 })
    );
    let call = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        call += 1;
        if (call === 2) {
          return new Response(
            JSON.stringify({ playlist: { id: 7, trackIds } }),
            { headers: { "Content-Type": "application/json" } }
          );
        }
        return new Promise<Response>(() => undefined);
      });

    const request = getPlaylistDetail("7", "", {
      limit: NETEASE_PLAYLIST_MAX_TRACKS,
    });
    const rejection = expect(request).rejects.toThrow(/deadline|budget/i);

    await vi.advanceTimersByTimeAsync(NETEASE_PLAYLIST_WALL_CLOCK_MS + 1);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(NETEASE_PLAYLIST_MAX_REQUESTS);
  });

  it("paginates a playlist whose full track ID list exceeds one page", async () => {
    const trackIds = Array.from(
      { length: NETEASE_PLAYLIST_MAX_TRACKS + 1 },
      (_, index) => ({ id: index + 1 })
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            playlist: {
              id: 7,
              trackCount: trackIds.length,
              trackIds,
            },
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            songs: Array.from(
              { length: NETEASE_PLAYLIST_PAGE_SIZE },
              (_, index) => ({ id: index + 1, name: `Song ${index + 1}` })
            ),
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );

    const detail = await getPlaylistDetail("7", "");

    expect(detail.tracks).toHaveLength(NETEASE_PLAYLIST_PAGE_SIZE);
    expect(detail.trackCount).toBe(trackIds.length);
    expect(detail.nextOffset).toBe(NETEASE_PLAYLIST_PAGE_SIZE);
    expect(detail.hasMore).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the requested offset for a continuation page", async () => {
    const trackIds = Array.from({ length: 250 }, (_, index) => ({
      id: index + 1,
    }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            playlist: { id: 7, trackCount: trackIds.length, trackIds },
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            songs: Array.from({ length: 100 }, (_, index) => ({
              id: index + 101,
              name: `Song ${index + 101}`,
            })),
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );

    const detail = await getPlaylistDetail("7", "", {
      offset: 100,
      limit: NETEASE_PLAYLIST_PAGE_SIZE,
    });

    expect(detail.tracks[0]?.id).toBe(101);
    expect(detail.tracks).toHaveLength(NETEASE_PLAYLIST_PAGE_SIZE);
    expect(detail.nextOffset).toBe(200);
    expect(detail.hasMore).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("slices a complete playlist even when the requested page limit is larger", async () => {
    const trackIds = Array.from({ length: 164 }, (_, index) => ({
      id: index + 1,
    }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            playlist: { id: 7, trackCount: trackIds.length, trackIds },
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            songs: Array.from({ length: 100 }, (_, index) => ({
              id: index + 65,
              name: `Song ${index + 65}`,
            })),
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );

    const detail = await getPlaylistDetail("7", "", {
      offset: 64,
      limit: NETEASE_PLAYLIST_MAX_TRACKS,
    });

    expect(detail.tracks).toHaveLength(100);
    expect(detail.nextOffset).toBe(164);
    expect(detail.hasMore).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a playlist whose total count exceeds the safety cap", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          playlist: {
            id: 7,
            trackCount: NETEASE_PLAYLIST_MAX_TOTAL_TRACKS + 1,
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

  it("rejects a truncated detail whose reported count exceeds the cap", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          playlist: {
            id: 7,
            trackCount: NETEASE_PLAYLIST_MAX_TOTAL_TRACKS + 1,
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

    const detail = await getPlaylistDetail("neplaylist_7", "", {
      limit: NETEASE_PLAYLIST_MAX_TRACKS,
    });

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
    vi.spyOn(globalThis, "fetch")
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

    const detail = await getPlaylistDetail("7", "", {
      limit: NETEASE_PLAYLIST_MAX_TRACKS,
    });

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
