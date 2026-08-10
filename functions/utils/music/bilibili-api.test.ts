// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BILIBILI_AUDIO_MAX_MEDIA_ATTEMPTS,
  createBilibiliAudioRequestBudget,
  fetchBilibiliDashCandidates,
  fetchBilibiliDurlSongUrls,
  fetchBilibiliSongUrls,
  proxyBilibiliAudio,
  proxyBilibiliCover,
} from "./bilibili-api";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Bilibili media response boundary", () => {
  it("resolves durl lazily with the same budget after DASH candidates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          code: 0,
          data: {
            dash: {
              audio: [
                {
                  base_url:
                    "https://upos-sz-mirrorcos.bilivideo.com/primary.m4s",
                  backup_url: [
                    "https://upos-sz-mirrorali.bilivideo.com/backup.m4s",
                  ],
                  bandwidth: 30280,
                  mime_type: "audio/mp4",
                  codecs: "mp4a.40.2",
                },
              ],
            },
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          code: 0,
          data: {
            durl: [
              {
                url: "https://upos-sz-mirrorcos.bilivideo.com/fallback.mp4",
                backup_url: [
                  "https://upos-sz-mirrorali.bilivideo.com/fallback.mp4",
                ],
                length: 182000,
                size: 728000,
              },
            ],
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const budget = createBilibiliAudioRequestBudget();

    const dash = await fetchBilibiliDashCandidates(
      "BV1xx411c7mD",
      2164311,
      budget
    );
    expect(dash).toEqual({
      cid: 2164311,
      urls: [
        "https://upos-sz-mirrorcos.bilivideo.com/primary.m4s",
        "https://upos-sz-mirrorali.bilivideo.com/backup.m4s",
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("fnval=16");

    await expect(
      fetchBilibiliDurlSongUrls("BV1xx411c7mD", dash!.cid, budget)
    ).resolves.toEqual([
      "https://upos-sz-mirrorcos.bilivideo.com/fallback.mp4",
      "https://upos-sz-mirrorali.bilivideo.com/fallback.mp4",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("fnval=0");
    expect(budget.requests).toBe(2);
  });

  it("does not reset the absolute deadline for the lazy durl request", async () => {
    vi.useFakeTimers();
    let durlSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_: RequestInfo | URL, _init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  Response.json({
                    code: 0,
                    data: { dash: { audio: [] } },
                  })
                ),
              15
            );
          })
      )
      .mockImplementationOnce((_: RequestInfo | URL, init?: RequestInit) => {
        durlSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      });
    vi.stubGlobal("fetch", fetchMock);
    const budget = createBilibiliAudioRequestBudget({ deadlineMs: 25 });

    const dashPromise = fetchBilibiliDashCandidates(
      "BV1xx411c7mD",
      2164311,
      budget
    );
    await vi.advanceTimersByTimeAsync(15);
    const dash = await dashPromise;
    const durlPromise = fetchBilibiliDurlSongUrls(
      "BV1xx411c7mD",
      dash!.cid,
      budget
    );
    const rejection = expect(durlPromise).rejects.toThrow(
      "Music upstream deadline exceeded"
    );

    await vi.advanceTimersByTimeAsync(11);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(durlSignal?.aborted).toBe(true);
  });

  it("uses a single native durl file when DASH has no audio", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ code: 0, data: { dash: { audio: [] } } })
      )
      .mockResolvedValueOnce(
        Response.json({
          code: 0,
          data: {
            durl: [
              {
                url: "https://upos-sz-mirrorcos.bilivideo.com/fallback.m4s",
              },
            ],
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBilibiliSongUrls("BV1xx411c7mD", 2164311)
    ).resolves.toEqual([
      "https://upos-sz-mirrorcos.bilivideo.com/fallback.m4s",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("fnval=16");
    expect(String(fetchMock.mock.calls[1][0])).toContain("fnval=0");
  });

  it.each([
    ["FLV", [{ url: "https://upos-sz-mirrorcos.bilivideo.com/fallback.flv" }]],
    [
      "multi-segment",
      [
        { url: "https://upos-sz-mirrorcos.bilivideo.com/part-1.m4s" },
        { url: "https://upos-sz-mirrorcos.bilivideo.com/part-2.m4s" },
      ],
    ],
  ])("rejects non-native %s durl fallback", async (_name, durl) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ code: 0, data: { dash: { audio: [] } } })
        )
        .mockResolvedValueOnce(Response.json({ code: 0, data: { durl } }))
    );

    await expect(
      fetchBilibiliSongUrls("BV1xx411c7mD", 2164311)
    ).resolves.toEqual([]);
  });

  it("caps all media attempts even when provider candidates remain", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            Response.json(
              { code: -404, message: "expired capability" },
              { status: 200 }
            )
          )
        )
    );
    const budget = createBilibiliAudioRequestBudget();

    for (
      let attempt = 0;
      attempt < BILIBILI_AUDIO_MAX_MEDIA_ATTEMPTS;
      attempt += 1
    ) {
      await expect(
        proxyBilibiliAudio(
          "BV1xx411c7mD",
          `https://upos-sz-mirrorcos.bilivideo.com/${attempt}.m4s`,
          undefined,
          budget
        )
      ).rejects.toThrow("Audio upstream type is not allowed");
    }
    await expect(
      proxyBilibiliAudio(
        "BV1xx411c7mD",
        "https://upos-sz-mirrorcos.bilivideo.com/overflow.m4s",
        undefined,
        budget
      )
    ).rejects.toThrow("media attempt budget exceeded");
    expect(fetch).toHaveBeenCalledTimes(BILIBILI_AUDIO_MAX_MEDIA_ATTEMPTS);
  });

  it("never forwards an upstream public cache policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("audio", {
          headers: {
            "Content-Type": "audio/mp4",
            "Content-Length": "5",
            "Cache-Control": "public, max-age=86400",
          },
        })
      )
    );

    const response = await proxyBilibiliAudio(
      "BV1xx411c7mD",
      "https://upos-sz-mirrorcos.bilivideo.com/a.m4s?upsig=server-only&deadline=1"
    );

    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).not.toContain("86400");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.text()).resolves.toBe("audio");
  });

  it("uses the hardened private audio boundary with Bilibili request headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("part", {
        status: 206,
        statusText: "upsig=status-capability-canary",
        headers: {
          "Content-Type": "Audio/MPEG; x-opaque=type-capability-canary",
          "Content-Length": "0004",
          "Content-Range": "bytes 00-03/010",
          "Accept-Ranges": "BYTES",
          ETag: '"upsig=etag-capability-canary"',
          "Last-Modified": "credential=metadata-canary",
          "Cache-Control": "public, max-age=86400",
        },
      })
    );
    const cacheOpen = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { open: cacheOpen });

    const response = await proxyBilibiliAudio(
      "BV1xx411c7mD",
      "https://upos-sz-mirrorcos.bilivideo.com/a.m4s?upsig=url-capability-canary",
      "bytes=0-3"
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwarded = init.headers as Record<string, string>;
    const serializedHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      serializedHeaders[name] = value;
    });

    expect(forwarded.referer).toBe(
      "https://www.bilibili.com/video/BV1xx411c7mD"
    );
    expect(forwarded["user-agent"]).toContain("Mozilla/5.0");
    expect(forwarded.range).toBe("bytes=0-3");
    expect(forwarded.cookie).toBeUndefined();
    expect(response.status).toBe(206);
    expect(response.statusText).not.toContain("capability-canary");
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("last-modified")).toBeNull();
    expect(JSON.stringify(serializedHeaders)).not.toContain(
      "capability-canary"
    );
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0"
    );
    expect(cacheOpen).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("part");
  });

  it("rejects a 200 JSON body so the route can try the next CDN", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { code: -404, message: "expired capability" },
            { status: 200 }
          )
        )
    );

    await expect(
      proxyBilibiliAudio(
        "BV1xx411c7mD",
        "https://upos-sz-mirrorcos.bilivideo.com/a.m4s"
      )
    ).rejects.toThrow("Audio upstream type is not allowed");
  });

  it("rejects an untyped binary response without a native media path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("opaque", {
          headers: { "Content-Type": "application/octet-stream" },
        })
      )
    );

    await expect(
      proxyBilibiliAudio(
        "BV1xx411c7mD",
        "https://upos-sz-mirrorcos.bilivideo.com/opaque"
      )
    ).rejects.toThrow("no playable media type");
  });

  it("rejects an audio-typed status outside the canonical 200/206 set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("range rejected", {
          status: 416,
          statusText: "upsig=status-capability-canary",
          headers: { "Content-Type": "audio/mpeg" },
        })
      )
    );

    await expect(
      proxyBilibiliAudio(
        "BV1xx411c7mD",
        "https://upos-sz-mirrorcos.bilivideo.com/a.m4s"
      )
    ).rejects.toThrow("Audio upstream status is not allowed");
  });

  it("allows only raster cover headers and keeps query targets private", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("image", {
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": "5",
            "Set-Cookie": "session=must-not-forward",
            "Cache-Control": "public, max-age=999999",
            "Content-Security-Policy": "script-src *",
          },
        })
      )
    );

    const response = await proxyBilibiliCover(
      "https://i0.hdslb.com/cover.jpg?txSecret=unknown-capability"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox"
    );
  });

  it.each(["image/svg+xml", "application/xml"])(
    "rejects active cover type %s",
    async (contentType) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response("<active />", {
            headers: { "Content-Type": contentType },
          })
        )
      );

      await expect(
        proxyBilibiliCover("https://i0.hdslb.com/cover")
      ).rejects.toThrow("Proxy response type is not allowed");
    }
  );
});
