import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("@/lib/api/config", () => ({
  getApiUrl: () => "https://app.example",
}));

import {
  getBilibiliCoverUrl,
  getBilibiliSongUrl,
  searchBilibiliVideos,
} from "./bilibili-api";

describe("Bilibili browser BFF client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns a same-origin cover proxy URL", async () => {
    await expect(
      getBilibiliCoverUrl("https://i0.hdslb.com/cover.jpg")
    ).resolves.toMatch(
      /^https:\/\/app\.example\/music-api\/bilibili\/cover\?url=/
    );
  });

  it("searches only through the BFF", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ items: [], hasMore: false }))
    );
    await expect(searchBilibiliVideos("music", 1, 20)).resolves.toEqual({
      items: [],
      hasMore: false,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://app.example/music-api/bilibili/search"
    );
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("combines caller cancellation with the internal request deadline", async () => {
    let dispatchedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        dispatchedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          dispatchedSignal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" })
              ),
            { once: true }
          );
        });
      }
    );
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");

    const request = searchBilibiliVideos("cancel me", 1, 20, caller.signal);
    await vi.waitFor(() =>
      expect(dispatchedSignal).toBeInstanceOf(AbortSignal)
    );
    expect(dispatchedSignal).not.toBe(caller.signal);
    expect(caller.signal.aborted).toBe(false);

    caller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatchedSignal?.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("aborts a BFF request at the bounded internal timeout", async () => {
    vi.useFakeTimers();
    let dispatchedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        dispatchedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          dispatchedSignal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("timeout"), { name: "AbortError" })
              ),
            { once: true }
          );
        });
      }
    );

    const request = searchBilibiliVideos("timeout", 1, 20);
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(12_000);

    await rejection;
    expect(dispatchedSignal?.aborted).toBe(true);
  });

  it("builds an opaque same-origin audio URL without receiving a signed target", async () => {
    const result = await getBilibiliSongUrl("bilibili_BV1xx411c7mD_2164311");
    expect(result?.url).toBe(
      "https://app.example/music-api/bilibili/audio?bvid=BV1xx411c7mD&cid=2164311"
    );
    expect(result?.format).toBe("m4s");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
