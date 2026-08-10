// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidAudioRange, proxyPrivateAudio } from "./audio";

afterEach(() => vi.unstubAllGlobals());

describe("opaque audio proxy", () => {
  it.each([undefined, null, "bytes=0-", "bytes=0-99", "bytes=-100"])(
    "accepts a valid single range: %s",
    (range) => {
      expect(isValidAudioRange(range)).toBe(true);
    }
  );

  it.each([
    "bytes=100-1",
    "bytes=-0",
    "bytes=0-1,4-5",
    "items=0-1",
    " bytes=0-1",
    `bytes=0-${"1".repeat(65)}`,
  ])("rejects an unsafe range: %s", (range) => {
    expect(isValidAudioRange(range)).toBe(false);
  });

  it("keeps a signed target server-side and preserves a safe 206 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("part", {
        status: 206,
        statusText: "vkey=status-capability-canary",
        headers: {
          "Content-Type": "Audio/MPEG; x-opaque=type-capability-canary",
          "Content-Length": "0004",
          "Content-Range": "bytes 00-03/010",
          "Accept-Ranges": "BYTES",
          ETag: '"vkey=header-capability-canary"',
          "Last-Modified": "credential=metadata-canary",
          "Set-Cookie": "MUSIC_U=header-credential-canary",
          "Cache-Control": "public, max-age=86400",
        },
      })
    );
    const cacheOpen = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { open: cacheOpen });

    const response = await proxyPrivateAudio(
      "http://m10.music.126.net/a.mp3?vkey=url-capability-canary&deadline=1",
      {
        Cookie: "MUSIC_U=request-credential-canary",
        Authorization: "Bearer request-credential-canary",
        Referer: "https://music.163.com/",
      },
      "bytes=0-3"
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwarded = init.headers as Record<string, string>;
    const body = await response.text();

    expect(fetchMock.mock.calls[0][0]).toContain("url-capability-canary");
    expect(fetchMock.mock.calls[0][0]).toMatch(/^https:/);
    expect(forwarded.range).toBe("bytes=0-3");
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded.authorization).toBeUndefined();
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("last-modified")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0"
    );
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(body).toBe("part");
    expect(response.statusText).not.toContain("status-capability-canary");
    const serializedHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      serializedHeaders[name] = value;
    });
    expect(JSON.stringify(serializedHeaders)).not.toContain(
      "capability-canary"
    );
    expect(cacheOpen).not.toHaveBeenCalled();
  });

  it("rejects non-audio and malformed partial responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ url: "https://attacker.test/?vkey=body-canary" })
      )
      .mockResolvedValueOnce(
        new Response("part", {
          status: 206,
          headers: { "Content-Type": "audio/mpeg" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      proxyPrivateAudio("https://m10.music.126.net/a.mp3", {})
    ).rejects.toThrow("type is not allowed");
    await expect(
      proxyPrivateAudio("https://m10.music.126.net/a.mp3", {})
    ).rejects.toThrow("range is invalid");
  });

  it("drops non-byte Accept-Ranges values instead of exposing an upstream side channel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("audio", {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Accept-Ranges": "opaque-capability-canary",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyPrivateAudio(
      "https://m10.music.126.net/a.mp3",
      {}
    );

    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(await response.text()).toBe("audio");
  });

  it("drops Content-Range on 200 and strips arbitrary Content-Type parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("audio", {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg; x-opaque=type-header-canary",
          "Content-Range": "opaque-range-header-canary",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyPrivateAudio(
      "https://m10.music.126.net/a.mp3",
      {}
    );
    const serializedHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      serializedHeaders[name] = value;
    });

    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-range")).toBeNull();
    expect(JSON.stringify(serializedHeaders)).not.toContain("header-canary");
    expect(await response.text()).toBe("audio");
  });

  it("forwards an absolute deadline without starting an expired media fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      proxyPrivateAudio("https://m10.music.126.net/a.mp3", {}, undefined, {
        deadlineAt: Date.now() - 1,
      })
    ).rejects.toThrow("Proxy request deadline exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
