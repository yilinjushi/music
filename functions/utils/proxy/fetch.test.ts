import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROXY_RESPONSE_BYTES,
  assertProxyResponse,
  isAllowedProxyHost,
  isValidUrl,
  normalizeProxyTarget,
  safeFetch,
} from "./fetch";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("proxy target policy", () => {
  it("requires HTTPS instead of silently changing the requested scheme", () => {
    expect(normalizeProxyTarget("http://bd-er.kuwo.cn/a.mp3")).toBeNull();
    expect(
      normalizeProxyTarget("https://bd-er.kuwo.cn/a.mp3")?.toString()
    ).toBe("https://bd-er.kuwo.cn/a.mp3");
  });

  it.each([
    "https://example.com/audio.mp3",
    "http://127.0.0.1/secret",
    "https://[::1]/secret",
    "https://localhost/secret",
    "https://music.163.com.evil.example/audio",
    "https://user:pass@music.163.com/audio",
    "https://music.163.com:8443/audio",
    "https://unrelated.qq.com/audio",
    "https://account.bilibili.com/audio",
    "https://community.kugou.com/audio",
    "https://store.kuwo.cn/audio",
    "https://sub.lyric.migu.cn/song.lrc",
    "https://lyric.migu.cn.attacker.test/song.lrc",
    "https://example.migu.cn/audio",
    "https://lxmusicapi.onrender.com/url/kw/track",
    "file:///etc/passwd",
  ])("rejects an unapproved target: %s", (url) => {
    expect(isValidUrl(url)).toBe(false);
  });

  it.each([
    "https://m10.music.126.net/audio.mp3",
    "https://bd-er.kuwo.cn/audio.mp3",
    "https://isure6.stream.qqmusic.qq.com/audio.m4a",
    "https://hk.stream.music.joox.com/audio.mp3",
    "https://webfs.kugou.com/audio.mp3",
    "https://lyric.migu.cn/song.lrc",
    "https://upos-sz-mirrorcos.bilivideo.com/audio.m4s",
    "https://i0.hdslb.com/cover.jpg",
  ])("accepts an explicit provider media host: %s", (url) => {
    expect(isValidUrl(url)).toBe(true);
  });

  it("matches a host only at a DNS label boundary", () => {
    expect(isAllowedProxyHost("a.music.126.net")).toBe(true);
    expect(isAllowedProxyHost("music.126.net.attacker.test")).toBe(false);
    expect(isAllowedProxyHost("hk.stream.music.joox.com")).toBe(true);
    expect(isAllowedProxyHost("sg.stream.music.joox.com")).toBe(false);
    expect(isAllowedProxyHost("hk.stream.music.joox.com.attacker.test")).toBe(
      false
    );
    expect(isAllowedProxyHost("lyric.migu.cn")).toBe(true);
    expect(isAllowedProxyHost("sub.lyric.migu.cn")).toBe(false);
    expect(isAllowedProxyHost("lyric.migu.cn.attacker.test")).toBe(false);
  });
});

describe("safeFetch", () => {
  it("validates every redirect hop", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://m11.music.126.net/final.mp3" },
        })
      )
      .mockResolvedValueOnce(
        new Response("audio", {
          status: 200,
          headers: { "content-type": "audio/mpeg", "content-length": "5" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await safeFetch("https://m10.music.126.net/start", {});
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
    await expect(response.text()).resolves.toBe("audio");
  });

  it("blocks a redirect to an arbitrary host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/private" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      safeFetch("https://m10.music.126.net/start", {})
    ).rejects.toThrow("redirect target is not allowed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes sensitive and arbitrary request headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("audio", {
        headers: { "content-type": "audio/mpeg", "content-length": "5" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await safeFetch("https://m10.music.126.net/a.mp3", {
      Cookie: "secret",
      Authorization: "Bearer secret",
      "X-Request-Key": "retired-provider-secret",
      Range: "bytes=0-10",
      "X-Arbitrary": "no",
    });
    const forwarded = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded.authorization).toBeUndefined();
    expect(forwarded["x-request-key"]).toBeUndefined();
    expect(forwarded["x-arbitrary"]).toBeUndefined();
    expect(forwarded.range).toBe("bytes=0-10");
    await response.arrayBuffer();
  });

  it("preserves an allowed partial media response for Range playback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("part", {
        status: 206,
        headers: {
          "content-type": "audio/mpeg",
          "content-length": "4",
          "content-range": "bytes 0-3/10",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await safeFetch("https://m10.music.126.net/a.mp3", {
      Range: "bytes=0-3",
    });
    const forwarded = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(forwarded.range).toBe("bytes=0-3");
    await expect(response.text()).resolves.toBe("part");
  });

  it("aborts when connection or response headers exceed their timeout", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((_: string, init?: RequestInit) => {
        fetchSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      })
    );

    const request = safeFetch(
      "https://m10.music.126.net/a.mp3",
      {},
      {
        connectionMs: 20,
        streamIdleMs: 40,
        streamTotalMs: 200,
      }
    );
    const rejection = expect(request).rejects.toThrow(
      "Proxy connection timed out"
    );

    await vi.advanceTimersByTimeAsync(21);
    await rejection;
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("keeps one absolute header deadline across redirect hops", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      if (signals.length === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(null, {
                  status: 302,
                  headers: {
                    location: "https://m11.music.126.net/final.mp3",
                  },
                })
              ),
            15
          );
        });
      }
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = safeFetch(
      "https://m10.music.126.net/start",
      {},
      {
        connectionMs: 100,
        deadlineAt: Date.now() + 25,
      }
    );
    const rejection = expect(request).rejects.toThrow(
      "Proxy request deadline exceeded"
    );

    await vi.advanceTimersByTimeAsync(16);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(signals[1]?.aborted).toBe(true);
  });

  it("propagates caller cancellation while response headers are pending", async () => {
    const caller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_: string, init?: RequestInit) => {
        upstreamSignal = init?.signal ?? undefined;
        return new Promise<Response>((_, reject) => {
          upstreamSignal?.addEventListener(
            "abort",
            () => reject(upstreamSignal?.reason),
            { once: true }
          );
        });
      })
    );

    const reason = new DOMException("downstream cancelled", "AbortError");
    const request = safeFetch(
      "https://m10.music.126.net/a.mp3",
      {},
      {
        signal: caller.signal,
      }
    );
    caller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("rejects an expired deadline before starting a fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      safeFetch(
        "https://m10.music.126.net/a.mp3",
        {},
        {
          deadlineAt: Date.now() - 1,
        }
      )
    ).rejects.toThrow("Proxy request deadline exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams beyond the header timeout while every chunk remains active", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let fetchSignal: AbortSignal | null = null;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(encoder.encode("a")), 30);
        setTimeout(() => controller.enqueue(encoder.encode("b")), 60);
        setTimeout(() => controller.enqueue(encoder.encode("c")), 90);
        setTimeout(() => controller.close(), 105);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_: string, init?: RequestInit) => {
        fetchSignal = init?.signal as AbortSignal;
        return Promise.resolve(
          new Response(upstream, {
            headers: { "content-type": "audio/mpeg" },
          })
        );
      })
    );

    const response = await safeFetch(
      "https://m10.music.126.net/a.mp3",
      {},
      {
        connectionMs: 20,
        streamIdleMs: 40,
        streamTotalMs: 150,
      }
    );
    const body = response.text();
    const bodyResult = expect(body).resolves.toBe("abc");

    await vi.advanceTimersByTimeAsync(110);
    await bodyResult;
    expect(fetchSignal?.aborted).toBe(false);
  });

  it("rejects and aborts when one stream gap exceeds the idle timeout", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | null = null;
    let cancelReason = "";
    const upstream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelReason = String(reason);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_: string, init?: RequestInit) => {
        fetchSignal = init?.signal as AbortSignal;
        return Promise.resolve(
          new Response(upstream, {
            headers: { "content-type": "audio/mpeg" },
          })
        );
      })
    );

    const response = await safeFetch(
      "https://m10.music.126.net/a.mp3",
      {},
      {
        connectionMs: 20,
        streamIdleMs: 40,
        streamTotalMs: 200,
      }
    );
    const body = response.text();
    const bodyResult = expect(body).rejects.toThrow(
      "Proxy response stream became idle"
    );

    await vi.advanceTimersByTimeAsync(41);
    await bodyResult;
    expect(fetchSignal?.aborted).toBe(true);
    expect(cancelReason).toBe("Proxy response stream became idle");
  });

  it("caps an active stream by absolute duration instead of allowing it forever", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        intervalId = setInterval(
          () => controller.enqueue(new Uint8Array([1])),
          10
        );
      },
      cancel() {
        if (intervalId !== null) clearInterval(intervalId);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_: string, init?: RequestInit) => {
        fetchSignal = init?.signal as AbortSignal;
        return Promise.resolve(
          new Response(upstream, {
            headers: { "content-type": "audio/mpeg" },
          })
        );
      })
    );

    const response = await safeFetch(
      "https://m10.music.126.net/a.mp3",
      {},
      {
        connectionMs: 20,
        streamIdleMs: 25,
        streamTotalMs: 65,
      }
    );
    const reader = response.body!.getReader();
    const reading = (async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    })();
    const bodyResult = expect(reading).rejects.toThrow(
      "Proxy response stream exceeded total duration"
    );

    await vi.advanceTimersByTimeAsync(70);
    await bodyResult;
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("enforces the byte limit while streaming without Content-Length", async () => {
    const chunk = new Uint8Array(10 * 1024 * 1024);
    let fetchSignal: AbortSignal | null = null;
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_: string, init?: RequestInit) => {
        fetchSignal = init?.signal as AbortSignal;
        return Promise.resolve(
          new Response(upstream, {
            headers: { "content-type": "audio/mpeg" },
          })
        );
      })
    );

    const response = await safeFetch("https://m10.music.126.net/a.mp3", {});
    const reader = response.body!.getReader();
    let streamError: unknown;
    let successfulReads = 0;
    for (let readCount = 0; readCount < 20; readCount += 1) {
      try {
        const { done } = await reader.read();
        if (!done) successfulReads += 1;
      } catch (error) {
        streamError = error;
        break;
      }
    }

    expect(streamError).toBeInstanceOf(Error);
    expect((streamError as Error).message).toContain(
      "Proxy response exceeds size limit"
    );
    expect(successfulReads).toBeGreaterThan(0);
    expect(successfulReads).toBeLessThanOrEqual(15);
    expect(fetchSignal?.aborted).toBe(true);
    expect(upstreamCancelled).toBe(true);
  });
});

describe("proxy response policy", () => {
  it("rejects missing, oversized, and HTML Content-Type responses", () => {
    expect(() => assertProxyResponse(new Response(null))).toThrow(
      "Content-Type is required"
    );

    expect(() =>
      assertProxyResponse(
        new Response(null, {
          headers: {
            "content-type": "audio/mpeg",
            "content-length": String(MAX_PROXY_RESPONSE_BYTES + 1),
          },
        })
      )
    ).toThrow("size limit");

    expect(() =>
      assertProxyResponse(
        new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        })
      )
    ).toThrow("type is not allowed");
  });
});
