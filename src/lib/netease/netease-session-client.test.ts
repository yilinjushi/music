import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkQrStatus,
  getArtistAlbums,
  getNeteaseSession,
  getPlaylists,
  getPlaylistDetail,
  getQrKey,
  getSongUrl,
  getSubscribedAlbums,
  getToplist,
  getUserPlaylists,
  logoutNeteaseSession,
  search,
} from "./netease-api";
import { useNeteaseStore } from "@/store/netease-store";
import { useUrlCacheStore } from "@/store/url-cache-store";
import { idbStorage } from "@/lib/storage-adapter";
import { normalizeAudioUrlForPlayback } from "@/lib/utils/audio-url";
import { useMarketSession } from "@/store/session/market-session";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

const profile = {
  userId: 42,
  nickname: "Client Tester",
  avatarUrl: "https://example.com/avatar.jpg",
};

describe("NetEase browser session client", () => {
  beforeEach(() => {
    localStorage.clear();
    useNeteaseStore.getState().clearSession();
    useMarketSession.getState().clearSession();
    vi.restoreAllMocks();
    vi.mocked(idbStorage.removeItem).mockReset().mockResolvedValue(undefined);
    useUrlCacheStore.setState({
      urlMap: {
        "netease:resolved:192": "https://media.example/private.mp3",
      },
    });
    expect(useUrlCacheStore.getState().urlMap).not.toEqual({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("clears local authentication when the server returns 401", async () => {
    useNeteaseStore.getState().setSession(profile);
    useMarketSession.getState().setMineData({
      recommend: [
        {
          id: "private-list",
          name: "Private list",
          coverUrl: "https://example.com/private.jpg",
          playCount: 1,
        },
      ],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(getNeteaseSession()).rejects.toThrow("Unauthorized");
    expect(useNeteaseStore.getState().authenticated).toBe(false);
    expect(useNeteaseStore.getState().user).toBeNull();
    expect(useUrlCacheStore.getState().urlMap).toEqual({});
    expect(useMarketSession.getState().mineData.recommend).toBeNull();
    expect(idbStorage.removeItem).toHaveBeenCalledWith("oh_url_cache_store");
  });

  it("does not surface a 401 until legacy IndexedDB URL deletion completes", async () => {
    let finishRemoval!: () => void;
    const removal = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    vi.mocked(idbStorage.removeItem).mockReturnValueOnce(removal);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    let settled = false;
    const request = getNeteaseSession().catch((error: unknown) => {
      settled = true;
      throw error;
    });
    await vi.waitFor(() => {
      expect(idbStorage.removeItem).toHaveBeenCalledWith("oh_url_cache_store");
    });
    expect(settled).toBe(false);

    finishRemoval();
    await expect(request).rejects.toThrow("Unauthorized");
    expect(settled).toBe(true);
  });

  it("clears resolved URLs in memory and legacy storage on confirmed logout", async () => {
    useNeteaseStore.getState().setSession(profile);
    useMarketSession.getState().setMineData({
      albums: [
        {
          id: 7,
          name: "Private album",
          picUrl: "https://example.com/album.jpg",
          publishTime: 0,
          size: 1,
        },
      ],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(logoutNeteaseSession()).resolves.toBeUndefined();

    expect(useUrlCacheStore.getState().urlMap).toEqual({});
    expect(useNeteaseStore.getState().authenticated).toBe(false);
    expect(useMarketSession.getState().mineData.albums).toBeNull();
    expect(idbStorage.removeItem).toHaveBeenCalledWith("oh_url_cache_store");
  });

  it("does not resolve logout until legacy IndexedDB URL deletion completes", async () => {
    let finishRemoval!: () => void;
    const removal = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    vi.mocked(idbStorage.removeItem).mockReturnValueOnce(removal);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    let settled = false;
    const logout = logoutNeteaseSession().then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(idbStorage.removeItem).toHaveBeenCalledWith("oh_url_cache_store");
    });
    expect(settled).toBe(false);

    finishRemoval();
    await logout;
    expect(settled).toBe(true);
  });

  it("clears account data repopulated while confirmed logout was in flight", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      useMarketSession.getState().setMineData({
        recommend: [
          {
            id: "in-flight-old-owner",
            name: "In-flight old owner",
            coverUrl: "https://example.com/in-flight.jpg",
            playCount: 1,
          },
        ],
      });
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    useNeteaseStore.getState().setSession(profile);

    await logoutNeteaseSession();

    expect(useNeteaseStore.getState().authenticated).toBe(false);
    expect(useMarketSession.getState().mineData.recommend).toBeNull();
  });

  it("never serializes a caller-supplied MUSIC_U in browser requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { result: { songs: [], songCount: 0 }, code: 200 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await search("safe query", 1, 1, 20, "MUSIC_U=must-not-leave-browser");
    const [, init] = fetchMock.mock.calls[0];
    const serialized = JSON.stringify(init);

    expect(init?.credentials).toBe("include");
    expect(serialized).not.toContain("MUSIC_U");
    expect(serialized.toLowerCase()).not.toContain('"cookie"');
  });

  it("combines a search caller signal with the internal deadline", async () => {
    let dispatchedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
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

    const request = search("cancel me", 1, 1, 20, "", caller.signal);
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

  it("does not let an aborted stale 401 clear a newer account owner", async () => {
    let resolveResponse!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockReturnValue(pendingResponse);
    const staleOwner = new AbortController();
    const request = getNeteaseSession(staleOwner.signal);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());

    staleOwner.abort();
    useNeteaseStore.getState().setSession(profile);
    useMarketSession.getState().setMineData({
      recommend: [
        {
          id: "new-owner-list",
          name: "New owner list",
          coverUrl: "https://example.com/new-owner.jpg",
          playCount: 1,
        },
      ],
    });
    resolveResponse(
      new Response(JSON.stringify({ error: "stale unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(useNeteaseStore.getState().user).toEqual(profile);
    expect(useMarketSession.getState().mineData.recommend).toHaveLength(1);
  });

  it("aborts a NetEase request at the bounded internal timeout", async () => {
    vi.useFakeTimers();
    let dispatchedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
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

    const request = search("timeout", 1, 1, 20);
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(12_000);

    await rejection;
    expect(dispatchedSignal?.aborted).toBe(true);
  });

  it("always sends playback requests through the same-origin session API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            data: [
              {
                url: "/music-api/netease/audio?id=123&br=320000",
                br: 320000,
                size: 0,
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const result = await getSongUrl(
      "netrack_123",
      320000,
      "legacy-secret-must-be-ignored"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/music-api/netease/song-url");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(JSON.parse(String(init?.body))).toEqual({ id: "123", br: 320000 });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      "legacy-secret-must-be-ignored"
    );
    const playbackUrl = result.data.data[0].url;
    expect(playbackUrl).not.toMatch(/vkey|deadline|signature/i);
    expect(normalizeAudioUrlForPlayback(playbackUrl)).toBe(playbackUrl);
  });

  it("keeps QR capabilities out of request URLs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 801, message: "waiting" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await checkQrStatus("key&injected=true");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/music-api/netease/login/qr/check");
    expect(String(url)).not.toContain("key&injected=true");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      key: "key&injected=true",
    });
    expect(init?.credentials).toBe("include");
  });

  it("forwards QR owner signals without adding request URL state", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ code: 200, data: { code: 200, unikey: "qr-key" } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    const owner = new AbortController();

    await expect(getQrKey(owner.signal)).resolves.toBe("qr-key");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/music-api/netease/login/qr/key");
    expect(String(url)).not.toContain("qr-key");
    expect(String(url)).not.toContain("timestamp");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal).not.toBe(owner.signal);
    expect(init?.cache).toBe("no-store");
  });

  it("normalizes album and nested artist artwork before returning account data", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              hotAlbums: [
                {
                  id: 11,
                  name: "Artist album",
                  picUrl: "http://p1.music.126.net/album.jpg?param=300y300",
                  publishTime: 123,
                  size: 12,
                  type: "EP",
                  upstreamPrivate: "strip-me",
                  artist: {
                    id: 22,
                    name: "Artist",
                    picUrl: "http://p2.music.126.net/artist.jpg?param=100y100",
                    albumSize: 3,
                    upstreamPrivate: "strip-me-too",
                  },
                },
              ],
              more: true,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              data: [
                {
                  id: 33,
                  name: "Subscribed album",
                  picUrl: "//p3.music.126.net/subscribed.jpg?resize=300",
                  publishTime: 456,
                  size: 9,
                  artist: {
                    id: 44,
                    name: "Subscribed artist",
                    picUrl: "http://p4.music.126.net/artist.jpg#fragment",
                    albumSize: 8,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    await expect(getArtistAlbums("neartist_22")).resolves.toEqual({
      hotAlbums: [
        {
          id: 11,
          name: "Artist album",
          picUrl: "https://p1.music.126.net/album.jpg",
          publishTime: 123,
          size: 12,
          type: "EP",
          artist: {
            id: 22,
            name: "Artist",
            picUrl: "https://p2.music.126.net/artist.jpg",
            albumSize: 3,
          },
        },
      ],
      more: true,
    });
    await expect(getSubscribedAlbums()).resolves.toEqual([
      {
        id: 33,
        name: "Subscribed album",
        picUrl: "https://p3.music.126.net/subscribed.jpg",
        publishTime: 456,
        size: 9,
        artist: {
          id: 44,
          name: "Subscribed artist",
          picUrl: "https://p4.music.126.net/artist.jpg",
          albumSize: 8,
        },
      },
    ]);
  });

  it("loads every user-playlist page using bounded limit and offset", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            more: true,
            playlist: [
              {
                id: 1,
                name: "Created",
                coverImgUrl: "https://example.com/1.jpg",
                playCount: 1,
                creator: { userId: 42, nickname: "Owner" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            more: false,
            playlist: [
              {
                id: 2,
                name: "Subscribed",
                coverImgUrl: "https://example.com/2.jpg",
                playCount: 2,
                creator: { userId: 7, nickname: "Other" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const playlists = await getUserPlaylists(
      "42",
      "MUSIC_U=ignored-legacy-value"
    );

    expect(playlists.map((playlist) => playlist.id)).toEqual(["1", "2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      limit: 100,
      offset: 0,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      limit: 100,
      offset: 100,
    });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      "ignored-legacy-value"
    );
  });

  it("never persists account-derived playlist details in Cache Storage or SWR", async () => {
    const cacheOpen = vi.fn();
    vi.stubGlobal("caches", { open: cacheOpen });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ playlist: { id: 7, tracks: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await getPlaylistDetail("neplaylist_7");
    await getPlaylistDetail("neplaylist_7");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.cache).toBe("no-store");
      expect(init?.credentials).toBe("include");
    }
    expect(cacheOpen).not.toHaveBeenCalled();
  });

  it("fetches market playlists and toplists with no-store and no Cache Storage", async () => {
    const cacheOpen = vi.fn();
    vi.stubGlobal("caches", { open: cacheOpen });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: { list: [], playlists: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await getToplist();
    await getPlaylists("全部", "hot", 30, 0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/toplist");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/playlists");
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.cache).toBe("no-store");
      expect(init?.credentials).toBe("include");
    }
    expect(cacheOpen).not.toHaveBeenCalled();
  });
});
