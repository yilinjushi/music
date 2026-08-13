// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { musicRoutes } from "./music";

beforeEach(() => {
  vi.stubGlobal("caches", {
    open: vi.fn().mockResolvedValue({
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn(),
      delete: vi.fn(),
    }),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("music route credential boundary", () => {
  it("never reads or writes Cache Storage for a URL capability response", async () => {
    const cache = {
      match: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const open = vi.fn().mockResolvedValue(cache);
    vi.stubGlobal("caches", { open });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          url: "https://cdn.example/song.mp3?X-Amz-Signature=unique-url-canary",
        })
      )
    );

    const response = await musicRoutes.request(
      "http://localhost/?source=joox&types=url&id=dHJhY2stY2FuYXJ5&br=192"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const text = await response.text();
    expect(text).toContain(
      "/music-api/audio?source=joox&id=dHJhY2stY2FuYXJ5&br=192"
    );
    expect(text).not.toContain("unique-url-canary");
    expect(fetch).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("rejects a credential assignment nested in a JSON body", async () => {
    const response = await musicRoutes.request(
      "http://localhost/netease/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: "safe",
          metadata: { note: "MUSIC_U=canary-body" },
        }),
      }
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("canary-body");
  });

  it("rejects encoded sensitive query values before forwarding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await musicRoutes.request(
      "http://localhost/?name=MUSIC_U%253Dcanary-query"
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("canary-query");
  });

  it("rejects a raw provider credential in the Cookie header", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await musicRoutes.request(
      "http://localhost/?source=qq&types=search&name=safe",
      { headers: { Cookie: "MUSIC_U=canary-cookie" } }
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("canary-cookie");
  });

  it("allows only the signed app session cookie into NetEase routes", async () => {
    const opaqueSession = `${"a".repeat(43)}.${"b".repeat(43)}`;
    const response = await musicRoutes.request(
      "https://music.example/netease/playlist",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://music.example",
          "Sec-Fetch-Site": "same-origin",
          Cookie: `__Host-otter_netease_session=${opaqueSession}`,
        },
        body: JSON.stringify({ playlistId: "invalid" }),
      },
      { APP_ORIGIN: "https://music.example" } as never
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid playlist ID" });

    const malformed = await musicRoutes.request(
      "https://music.example/netease/playlist",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://music.example",
          "Sec-Fetch-Site": "same-origin",
          Cookie: "__Host-otter_netease_session=MUSIC_U=canary-cookie",
        },
        body: JSON.stringify({ playlistId: "7" }),
      },
      { APP_ORIGIN: "https://music.example" } as never
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain("canary-cookie");
  });

  it("rejects sensitive form, text, and header fields", async () => {
    const formResponse = await musicRoutes.request(
      "http://localhost/netease/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "note=MUSIC_U%3Dcanary-form",
      }
    );
    const textResponse = await musicRoutes.request(
      "http://localhost/netease/search",
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: '{"note":"MUSIC_U=canary-text"}',
      }
    );
    const headerResponse = await musicRoutes.request(
      "http://localhost/?source=qq&types=search&name=safe",
      { headers: { "Set-Cookie": "opaque-canary" } }
    );

    expect(formResponse.status).toBe(400);
    expect(textResponse.status).toBe(400);
    expect(headerResponse.status).toBe(400);
  });

  it("rejects an upstream canary before it can be cached or returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ data: { note: "MUSIC_U=canary-response" } })
        )
    );
    const response = await musicRoutes.request(
      "http://localhost/?source=qq&types=search&name=safe"
    );
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toContain("Music upstream failed");
    expect(text).not.toContain("canary-response");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("never returns or logs the raw upstream exception", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new Error("https://music.example/?MUSIC_U=canary-exception")
        )
    );
    const response = await musicRoutes.request(
      "http://localhost/?source=qq&types=search&name=safe"
    );
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toContain("Music upstream failed");
    expect(text).not.toContain("canary-exception");
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(
      "canary-exception"
    );
  });

  it("maps an absolute upstream timeout to the fixed 502 boundary", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        markFetchStarted();
        return new Promise<Response>(() => undefined);
      })
    );

    const responsePromise = musicRoutes.request(
      "http://localhost/?source=qq&types=search&name=timeout-canary"
    );
    const { MUSIC_UPSTREAM_DEADLINE_MS } = await import("@otter-music/shared");
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(MUSIC_UPSTREAM_DEADLINE_MS + 1);
    const response = await responsePromise;
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toBe('{"error":"Music upstream failed"}');
    expect(body).not.toContain("timeout-canary");
    expect(JSON.stringify(consoleSpy.mock.calls)).toBe(
      '[["[functions] MUSIC_UPSTREAM_FAILED"]]'
    );
    expect(signal?.aborted).toBe(true);
  });
});
