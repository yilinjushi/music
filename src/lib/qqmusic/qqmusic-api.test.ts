import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseQqMusicUrl,
  buildQqPlaylistApiPath,
  parseQqPlaylistResponse,
  convertQqSongToMusicTrack,
  getQqMusicUrl,
  getQqMusicLyric,
  searchQqMusic,
} from "./qqmusic-api";
import { convertQqSearchSongToMusicTrack } from "@otter-music/shared";
import { normalizeAudioUrlForPlayback } from "@/lib/utils/audio-url";

const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ============================================================
// parseQqMusicUrl
// ============================================================

describe("parseQqMusicUrl", () => {
  it("extracts playlist id from path-based QQ Music links", () => {
    expect(
      parseQqMusicUrl("https://y.qq.com/n/yqq/playlist/7177076625.html")
    ).toBe("7177076625");
  });

  it("extracts playlist id from ryqq_v2 playlist links", () => {
    expect(
      parseQqMusicUrl(
        "https://y.qq.com/n/ryqq_v2/playlist/3569246560?ADTAG=h5_share_playlist&redirecttag=mn.redirect.custom&mnst=2.27"
      )
    ).toBe("3569246560");
  });

  it("extracts playlist id from query-based QQ Music share links", () => {
    expect(
      parseQqMusicUrl(
        "https://i2.y.qq.com/n3/other/pages/details/playlist.html?platform=11&appshare=android_qq&appversion=20040508&hosteuin=oK6kowEAoK4z7ecsoKvsow6ANn**&id=3569246560&ADTAG=wxfshare"
      )
    ).toBe("3569246560");
  });

  it("rejects links without a numeric playlist id", () => {
    expect(
      parseQqMusicUrl("https://y.qq.com/n/yqq/playlist/not-a-number.html")
    ).toBeNull();
    expect(
      parseQqMusicUrl("https://i.y.qq.com/n2/m/share/details/taoge.html?id=abc")
    ).toBeNull();
  });

  it("rejects completely unrelated URLs", () => {
    expect(parseQqMusicUrl("https://example.com/some/page")).toBeNull();
    expect(parseQqMusicUrl("not a url")).toBeNull();
  });
});

// ============================================================
// buildQqPlaylistApiPath
// ============================================================

describe("buildQqPlaylistApiPath", () => {
  it("uses disstid parameter (not categoryID)", () => {
    const url = buildQqPlaylistApiPath("3569246560");
    expect(url).toContain("disstid=3569246560");
    expect(url).not.toContain("categoryID");
  });

  it("encodes the playlist id", () => {
    const url = buildQqPlaylistApiPath("abc%123");
    expect(url).toContain("disstid=abc%25123");
  });

  it("includes required compatibility parameters", () => {
    const url = buildQqPlaylistApiPath("123");
    expect(url).toContain("nosign=1");
    expect(url).toContain("g_tk=5381");
    expect(url).toContain("loginUin=0");
    expect(url).toContain("hostUin=0");
    expect(url).toContain("platform=yqq");
    expect(url).toContain("needNewCode=0");
    expect(url).toContain("format=json");
    expect(url).toContain("inCharset=GB2312");
    expect(url).toContain("outCharset=utf-8");
  });

  it("starts with the correct API path", () => {
    const url = buildQqPlaylistApiPath("123");
    expect(url).toMatch(
      /^\/qzone-music\/fcg-bin\/fcg_ucc_getcdinfo_byids_cp\.fcg\?/
    );
  });

  it("works with the user's playlist id", () => {
    const url = buildQqPlaylistApiPath("3569246560");
    expect(url).toContain("disstid=3569246560");
    expect(url).toContain("fcg_ucc_getcdinfo_byids_cp.fcg");
  });
});

// ============================================================
// parseQqPlaylistResponse
// ============================================================

describe("parseQqPlaylistResponse", () => {
  it("parses plain JSON", () => {
    const result = parseQqPlaylistResponse('{"code":0,"cdlist":[]}');
    expect(result).toEqual({ code: 0, cdlist: [] });
  });

  it("parses plain JSON containing parentheses in song names", () => {
    const result = parseQqPlaylistResponse(
      '{"code":0,"cdlist":[{"songlist":[{"songname":"不该 (with aMEI)"}]}]}'
    );

    expect(result.cdlist[0].songlist[0].songname).toBe("不该 (with aMEI)");
  });

  it("parses JSONP responses", () => {
    const result = parseQqPlaylistResponse(
      'jsonCallback({"code":0,"cdlist":[]})'
    );
    expect(result).toEqual({ code: 0, cdlist: [] });
  });

  it("throws for invalid non-JSONP text", () => {
    expect(() => parseQqPlaylistResponse("not json")).toThrow();
  });
});

// ============================================================
// convertQqSongToMusicTrack
// ============================================================

describe("convertQqSongToMusicTrack", () => {
  it("converts QQ Music song to MusicTrack format", () => {
    const track = convertQqSongToMusicTrack({
      songid: "123",
      songmid: "abc123",
      songname: "晴天",
      singer: [{ name: "周杰伦" }],
      albumname: "叶惠美",
      albummid: "xyz789",
      interval: 269,
    });

    expect(track.id).toBe("qq_abc123");
    expect(track.name).toBe("晴天");
    expect(track.artist).toEqual(["周杰伦"]);
    expect(track.album).toBe("叶惠美");
    expect(track.source).toBe("qq");
    expect(track.url_id).toBe("abc123");
    expect(track.lyric_id).toBe("abc123");
    expect(track.pic_id).toContain("xyz789");
    expect(track.pic_id).toContain("y.gtimg.cn");
    expect(track.duration).toBe(269);
  });

  it("handles multiple singers", () => {
    const track = convertQqSongToMusicTrack({
      songid: "1",
      songmid: "m1",
      songname: "某某",
      singer: [{ name: "A" }, { name: "B" }],
      albumname: "Album",
      albummid: "mid1",
      interval: 200,
    });

    expect(track.artist).toEqual(["A", "B"]);
  });

  it("handles empty albummid", () => {
    const track = convertQqSongToMusicTrack({
      songid: "1",
      songmid: "m1",
      songname: "Song",
      singer: [{ name: "Artist" }],
      albumname: "Album",
      albummid: "",
      interval: 200,
    });

    expect(track.pic_id).toBe("");
  });
});

describe("convertQqSearchSongToMusicTrack", () => {
  it("preserves QQ search duration in seconds", () => {
    const track = convertQqSearchSongToMusicTrack({
      mid: "search-mid",
      title: "爱错",
      singer: [{ name: "王力宏" }],
      album: { title: "心中的日月" },
      interval: 246,
    });

    expect(track.duration).toBe(246);
  });

  it("leaves missing or invalid duration unknown", () => {
    const base = {
      mid: "search-mid",
      title: "爱错",
      singer: [{ name: "王力宏" }],
      album: { title: "心中的日月" },
    };

    expect(convertQqSearchSongToMusicTrack(base).duration).toBeUndefined();
    expect(
      convertQqSearchSongToMusicTrack({ ...base, interval: 0 }).duration
    ).toBeUndefined();
  });
});

describe("QQ same-origin request deadline", () => {
  it("constructs a normalizer-safe opaque playback URL without a vkey", async () => {
    const url = await getQqMusicUrl("song-mid", 320);

    expect(url).toBe("/music-api/qqmusic/audio?songmid=song-mid&quality=320k");
    expect(url).not.toMatch(/vkey|deadline|signature/i);
    expect(normalizeAudioUrlForPlayback(url || "")).toBe(url);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps the requested playback ceiling into the opaque QQ quality", async () => {
    await expect(getQqMusicUrl("song-mid", 128)).resolves.toBe(
      "/music-api/qqmusic/audio?songmid=song-mid&quality=128k"
    );
    await expect(getQqMusicUrl("song-mid", 192)).resolves.toBe(
      "/music-api/qqmusic/audio?songmid=song-mid&quality=128k"
    );
    await expect(getQqMusicUrl("song-mid", 320)).resolves.toBe(
      "/music-api/qqmusic/audio?songmid=song-mid&quality=320k"
    );
    await expect(getQqMusicUrl("song-mid", 999)).resolves.toBe(
      "/music-api/qqmusic/audio?songmid=song-mid&quality=320k"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only the configured same-origin QQ BFF", async () => {
    localStorage.setItem(
      "otter_custom_api_url",
      JSON.stringify("https://attacker.example")
    );
    fetchMock.mockResolvedValue(Response.json({ items: [], hasMore: false }));

    await expect(searchQqMusic("晴天", 2)).resolves.toEqual({
      items: [],
      hasMore: false,
    });

    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestUrl = new URL(input);
    expect(requestUrl.origin).toBe(window.location.origin);
    expect(requestUrl.pathname).toBe("/music-api/qqmusic/proxy");
    expect(localStorage.getItem("otter_custom_api_url")).toBeNull();
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "search",
      query: "晴天",
      page: 2,
    });
  });

  it("aborts a hanging fetch at the absolute 12 second deadline", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let dispatchedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_: string, init?: RequestInit) => {
      dispatchedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });

    const request = searchQqMusic("timeout", 1, caller.signal);
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(12_001);

    await rejection;
    expect(dispatchedSignal).not.toBe(caller.signal);
    expect(caller.signal.aborted).toBe(false);
    expect(dispatchedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the same deadline active while the response body stalls", async () => {
    vi.useFakeTimers();
    let dispatchedSignal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"items":['));
      },
    });
    fetchMock.mockImplementation((_: string, init?: RequestInit) => {
      dispatchedSignal = init?.signal ?? undefined;
      return Promise.resolve(
        new Response(body, { headers: { "Content-Type": "application/json" } })
      );
    });

    const request = searchQqMusic("stalled body", 1);
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(12_001);

    await rejection;
    expect(dispatchedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("combines caller cancellation with the internal deadline signal", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let dispatchedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_: string, init?: RequestInit) => {
      dispatchedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });

    const request = searchQqMusic("cancelled", 1, caller.signal);
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(dispatchedSignal).not.toBe(caller.signal);
    caller.abort();
    await rejection;
    expect(dispatchedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an in-flight lyric request with the caller owner", async () => {
    const caller = new AbortController();
    let dispatchedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_: string, init?: RequestInit) => {
      dispatchedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });

    const request = getQqMusicLyric("song-mid", caller.signal);
    await vi.waitFor(() =>
      expect(dispatchedSignal).toBeInstanceOf(AbortSignal)
    );
    caller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatchedSignal?.aborted).toBe(true);
  });
});
