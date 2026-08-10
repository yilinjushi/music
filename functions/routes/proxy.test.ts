// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KVNamespace } from "../types/hono";
import { isAllowedProxyRequestOrigin, proxyRoutes } from "./proxy";

class MemoryKv implements KVNamespace {
  values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }

  async list() {
    return { keys: [] };
  }

  async getWithMetadata<T>() {
    return { value: null, metadata: null as T | null };
  }
}

const target = encodeURIComponent("https://cdn.music.126.net/song.mp3");

function createEnv() {
  return {
    oh_file_url: new MemoryKv(),
    APP_ORIGIN: "https://music.example",
  } as never;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      async () =>
        new Response("audio", {
          headers: { "content-type": "audio/mpeg", "content-length": "5" },
        })
    )
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("proxy request boundary", () => {
  it("rejects an explicit cross-site browser request", async () => {
    const response = await proxyRoutes.request(
      `https://api.music.example/?url=${target}`,
      { headers: { "Sec-Fetch-Site": "cross-site" } },
      createEnv()
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary Origin", async () => {
    const response = await proxyRoutes.request(
      `https://api.music.example/?url=${target}`,
      { headers: { Origin: "https://attacker.example" } },
      createEnv()
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "http://music.example",
    "https://music.example/",
    "https://music.example/path",
  ])(
    "fails closed for an invalid configured application origin: %s",
    (value) => {
      expect(
        isAllowedProxyRequestOrigin(
          "https://api.music.example/proxy",
          undefined,
          value
        )
      ).toBe(false);
    }
  );

  it("allows the configured application Origin and requests without Origin", async () => {
    const withOrigin = await proxyRoutes.request(
      `https://api.music.example/?url=${target}`,
      { headers: { Origin: "https://music.example" } },
      createEnv()
    );
    expect(withOrigin.status).toBe(200);
    await withOrigin.arrayBuffer();

    const withoutOrigin = await proxyRoutes.request(
      `https://api.music.example/?url=${target}`,
      undefined,
      createEnv()
    );
    expect(withoutOrigin.status).toBe(200);
    await withoutOrigin.arrayBuffer();
  });

  it("rejects sensitive target query values and custom headers", async () => {
    const sensitiveTarget = encodeURIComponent(
      "https://cdn.music.126.net/song.mp3?MUSIC_U=canary-target"
    );
    const targetResponse = await proxyRoutes.request(
      `https://api.music.example/?url=${sensitiveTarget}`,
      undefined,
      createEnv()
    );
    const sensitiveHeaders = encodeURIComponent(
      JSON.stringify({ Cookie: "MUSIC_U=canary-header" })
    );
    const headerResponse = await proxyRoutes.request(
      `https://api.music.example/?url=${target}&headers=${sensitiveHeaders}`,
      undefined,
      createEnv()
    );

    expect(targetResponse.status).toBe(400);
    expect(headerResponse.status).toBe(400);
    expect(await targetResponse.text()).not.toContain("canary-target");
    expect(await headerResponse.text()).not.toContain("canary-header");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://cdn.music.126.net/song.mp3?X-Amz-Signature=unique-amz-canary",
    "https://cdn.music.126.net/song.mp3?X-Goog-Credential=unique-goog-canary",
    "https://cdn.music.126.net/song.mp3?GoogleAccessId=unique-google-id-canary&Expires=9999999999&Signature=unique-signature-canary",
    "https://cdn.music.126.net/song.mp3?Policy=unique-policy-canary&Key-Pair-Id=unique-keypair-canary&sig=unique-sig-canary",
    "https://cdn.music.126.net/song.mp3?token=unique-token-canary",
    "https://cdn.music.126.net/song.mp3?vkey=unique-vkey-canary&deadline=9999999999",
    "https://cdn.music.126.net/song.mp3?upsig=unique-upsig-canary",
    "https://cdn.music.126.net/song.mp3?api_token=unique-api-token-canary",
    "https://cdn.music.126.net/song.mp3?secret=unique-secret-canary",
  ])(
    "rejects a credential or capability target before fetch: %s",
    async (rawTarget) => {
      const response = await proxyRoutes.request(
        `https://api.music.example/?url=${encodeURIComponent(rawTarget)}`,
        undefined,
        createEnv()
      );
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(text).not.toContain("unique-");
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("rejects account credentials even when a capability field is also present", async () => {
    const rawTarget =
      "https://cdn.music.126.net/song.mp3?token=unique-token-canary&password=unique-password-canary";
    const response = await proxyRoutes.request(
      `https://api.music.example/?url=${encodeURIComponent(rawTarget)}`,
      undefined,
      createEnv()
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toContain("unique-");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps an unsigned full response public and any Range request private", async () => {
    const publicResponse = await proxyRoutes.request(
      `https://api.music.example/?url=${target}`,
      undefined,
      createEnv()
    );
    expect(publicResponse.headers.get("cache-control")).toContain("public");
    await publicResponse.arrayBuffer();

    const rangeResponse = await proxyRoutes.request(
      `https://api.music.example/?url=${target}`,
      { headers: { Range: "bytes=0-3" } },
      createEnv()
    );
    expect(rangeResponse.headers.get("cache-control")).toContain("no-store");
    await rangeResponse.arrayBuffer();
  });

  it.each(["txSecret", "random_unknown_signature_71f4"])(
    "allows an unknown query target but always keeps %s responses private",
    async (parameterName) => {
      const unknownCapability = encodeURIComponent(
        `https://cdn.music.126.net/song.mp3?${parameterName}=unknown-query-canary`
      );
      const fullResponse = await proxyRoutes.request(
        `https://api.music.example/?url=${unknownCapability}`,
        undefined,
        createEnv()
      );
      expect(fullResponse.status).toBe(200);
      expect(fullResponse.headers.get("cache-control")).toContain("private");
      expect(fullResponse.headers.get("cache-control")).toContain("no-store");
      expect(fullResponse.headers.get("cache-control")).not.toContain("public");
      await fullResponse.arrayBuffer();

      const rangeResponse = await proxyRoutes.request(
        `https://api.music.example/?url=${unknownCapability}`,
        { headers: { Range: "bytes=0-3" } },
        createEnv()
      );
      expect(rangeResponse.status).toBe(200);
      expect(rangeResponse.headers.get("cache-control")).toContain("no-store");
      await rangeResponse.arrayBuffer();
    }
  );

  it("keeps a query-free non-200 upstream response private", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("missing", {
        status: 404,
        headers: {
          "content-type": "audio/mpeg",
          "content-length": "7",
        },
      })
    );

    const response = await proxyRoutes.request(
      `https://api.music.example/?url=${target}`,
      undefined,
      createEnv()
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    await response.arrayBuffer();
  });

  it.each(["image/svg+xml", "application/xml", "text/xml", "text/html"])(
    "rejects active same-origin content type %s",
    async (contentType) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response("<active-content />", {
          headers: { "Content-Type": contentType },
        })
      );

      const response = await proxyRoutes.request(
        `https://api.music.example/?url=${target}`,
        undefined,
        createEnv()
      );
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.text()).not.toContain("active-content");
    }
  );

  it("does not return or log URL, query, or raw exception details", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValueOnce(
      new Error("https://cdn.music.126.net/?MUSIC_U=canary-exception")
    );

    const response = await proxyRoutes.request(
      `https://api.music.example/?url=${target}`,
      undefined,
      createEnv()
    );
    const text = await response.text();
    const logged = JSON.stringify(consoleSpy.mock.calls);

    expect(response.status).toBe(502);
    expect(text).toContain("Proxy upstream failed");
    expect(text).not.toContain("music.126.net");
    expect(text).not.toContain("canary-exception");
    expect(logged).not.toContain("music.126.net");
    expect(logged).not.toContain("canary-exception");
  });
});
