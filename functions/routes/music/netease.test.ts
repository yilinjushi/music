import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, KVNamespace } from "../../types/hono";

const api = vi.hoisted(() => ({
  getSongUrl: vi.fn(),
  proxyNeteaseAudio: vi.fn(),
  getUserPlaylists: vi.fn(),
  getPlaylistDetail: vi.fn(),
  getPlaylistDynamicDetail: vi.fn(),
  getQrKey: vi.fn(),
  checkQrStatus: vi.fn(),
  getMyInfo: vi.fn(),
  getRecommendPlaylists: vi.fn(),
  search: vi.fn(),
  getLyric: vi.fn(),
  getSongDetail: vi.fn(),
  getToplist: vi.fn(),
  getAlbum: vi.fn(),
  getAlbumDynamicDetail: vi.fn(),
  getArtist: vi.fn(),
  getArtistDynamicDetail: vi.fn(),
  getArtistSongs: vi.fn(),
  getArtistAlbums: vi.fn(),
  getSubscribedAlbums: vi.fn(),
  getSubscribedArtists: vi.fn(),
  getPlaylists: vi.fn(),
  searchSuggest: vi.fn(),
  getHotComments: vi.fn(),
  getNewComments: vi.fn(),
  getMusicComments: vi.fn(),
  resolveUrl: vi.fn(),
  toggleSubArtist: vi.fn(),
  toggleSubAlbum: vi.fn(),
  toggleSubPlaylist: vi.fn(),
}));

vi.mock("../../utils/music/netease-api", () => api);

import { neteaseRoutes } from "./netease";

class MemoryKv implements KVNamespace {
  values = new Map<string, string>();

  async get(key: string, options?: { type?: string }) {
    const value = this.values.get(key) ?? null;
    return options?.type === "json" && value ? JSON.parse(value) : value;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }

  async list() {
    return { keys: [...this.values.keys()].map((name) => ({ name })) };
  }

  async getWithMetadata<T>() {
    return { value: null, metadata: null as T | null };
  }
}

const profile = {
  userId: 42,
  nickname: "Route Tester",
  avatarUrl: "https://example.com/avatar.jpg",
};

function createEnv(): Env {
  return {
    APP_ORIGIN: "https://music.example",
    oh_file_url: new MemoryKv(),
    SESSION_KV: new MemoryKv(),
    NETEASE_SESSION_HMAC_SECRET: "hmac-secret-32-characters-minimum-value",
    NETEASE_CREDENTIAL_ENC_KEY: "aes-secret-32-characters-minimum-value!",
    NETEASE_SESSION_TTL_SECONDS: "7200",
  };
}

async function qrLogin(env: Env) {
  api.checkQrStatus.mockResolvedValue({
    data: { code: 803, message: "ok", cookie: "MUSIC_U=body-leak" },
    cookie: "MUSIC_U=real-secret; __csrf=csrf-secret",
  });
  api.getMyInfo.mockResolvedValue({ data: { profile } });

  const response = await neteaseRoutes.request(
    "/login/qr/check",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "qr-key-1234" }),
    },
    env
  );
  const setCookie = response.headers.get("set-cookie") || "";
  return { response, cookie: setCookie.split(";")[0] };
}

describe("NetEase session routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("turns QR 803 into an opaque session without returning credentials", async () => {
    const env = createEnv();
    const { response, cookie } = await qrLogin(env);
    const text = await response.text();
    const stored = [...(env.SESSION_KV as MemoryKv).values.values()][0];

    expect(response.status).toBe(200);
    expect(text).not.toContain("MUSIC_U");
    expect(text.toLowerCase()).not.toContain('"cookie"');
    expect(cookie).not.toContain("real-secret");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(stored).not.toContain("MUSIC_U");
    expect(stored).not.toContain("real-secret");

    const me = await neteaseRoutes.request(
      "/session/me",
      { headers: { Cookie: cookie } },
      env
    );
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toEqual({
      authenticated: true,
      profile,
    });
  });

  it("rejects credentials supplied by the client", async () => {
    const env = createEnv();
    const response = await neteaseRoutes.request(
      "/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://music.example",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          keyword: "test",
          page: 1,
          limit: 20,
          cookie: "MUSIC_U=must-not-pass",
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(api.search).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("must-not-pass");
  });

  it("rejects a credential assignment hidden under an innocent field", async () => {
    const env = createEnv();
    const response = await neteaseRoutes.request(
      "/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: "test",
          page: 1,
          limit: 20,
          metadata: { note: "MUSIC_U=canary-body" },
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(api.search).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("canary-body");
  });

  it("rejects a raw provider credential sent as an HTTP Cookie", async () => {
    const env = createEnv();
    const response = await neteaseRoutes.request(
      "/session/me",
      { headers: { Cookie: "MUSIC_U=canary-cookie" } },
      env
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("canary-cookie");
  });

  it("uses the encrypted server credential for private routes", async () => {
    const env = createEnv();
    const { cookie } = await qrLogin(env);
    api.getRecommendPlaylists.mockResolvedValue({
      data: { result: [{ id: 1, name: "Private" }] },
      cookie: "MUSIC_U=upstream-refresh-secret",
    });

    const response = await neteaseRoutes.request(
      "/recommend",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: "{}",
      },
      env
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(api.getRecommendPlaylists).toHaveBeenCalledWith(
      "MUSIC_U=real-secret; __csrf=csrf-secret"
    );
    expect(text).not.toContain("MUSIC_U");
    expect(text.toLowerCase()).not.toContain('"cookie"');
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("validates and forwards user playlist pagination", async () => {
    const env = createEnv();
    const { cookie } = await qrLogin(env);
    api.getUserPlaylists.mockResolvedValue({
      code: 200,
      playlist: [],
      more: false,
    });

    const response = await neteaseRoutes.request(
      "/user-playlists",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ limit: 50, offset: 100 }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(api.getUserPlaylists).toHaveBeenCalledWith(
      "42",
      "MUSIC_U=real-secret; __csrf=csrf-secret",
      50,
      100
    );

    const invalid = await neteaseRoutes.request(
      "/user-playlists",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ limit: 201, offset: 0 }),
      },
      env
    );
    expect(invalid.status).toBe(400);
  });

  it("returns 401 without a session and revokes a session on logout", async () => {
    const env = createEnv();
    const unauthorized = await neteaseRoutes.request(
      "/recommend",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      env
    );
    expect(unauthorized.status).toBe(401);

    const { cookie } = await qrLogin(env);
    const logout = await neteaseRoutes.request(
      "/logout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: "{}",
      },
      env
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

    const after = await neteaseRoutes.request(
      "/session/me",
      { headers: { Cookie: cookie } },
      env
    );
    expect(after.status).toBe(401);
  });

  it("requires a session before issuing an opaque playback reference", async () => {
    const env = createEnv();
    const response = await neteaseRoutes.request(
      "/song-url",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "1" }),
      },
      env
    );
    expect(response.status).toBe(401);
    expect(api.getSongUrl).not.toHaveBeenCalled();
  });

  it("returns only a same-origin opaque playback reference", async () => {
    const env = createEnv();
    const { cookie } = await qrLogin(env);
    const response = await neteaseRoutes.request(
      "/song-url",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ id: "netrack_1", br: 320000 }),
      },
      env
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("/music-api/netease/audio?id=1&br=320000");
    expect(text).not.toContain("vkey");
    expect(api.getSongUrl).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("resolves a signed target server-side and preserves Range/206", async () => {
    const env = createEnv();
    const { cookie } = await qrLogin(env);
    api.getSongUrl.mockResolvedValue({
      data: {
        data: [
          {
            url: "https://m10.music.126.net/a.mp3?vkey=server-canary&deadline=1",
          },
        ],
      },
    });
    api.proxyNeteaseAudio.mockResolvedValue(
      new Response("part", {
        status: 206,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Range": "bytes 0-3/10",
          "Cache-Control": "private, no-store, max-age=0",
        },
      })
    );

    const response = await neteaseRoutes.request(
      "/audio?id=1&br=320000",
      { headers: { Cookie: cookie, Range: "bytes=0-3" } },
      env
    );
    const body = await response.text();

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(api.getSongUrl).toHaveBeenCalledWith(
      "1",
      320000,
      "MUSIC_U=real-secret; __csrf=csrf-secret"
    );
    expect(api.proxyNeteaseAudio).toHaveBeenCalledWith(
      expect.stringContaining("vkey=server-canary"),
      "bytes=0-3"
    );
    expect(body).toBe("part");
    expect(body).not.toContain("server-canary");
  });

  it("rejects credential/query injection before audio resolution", async () => {
    const env = createEnv();
    const { cookie } = await qrLogin(env);
    const response = await neteaseRoutes.request(
      "/audio?id=1&br=320000&vkey=browser-canary",
      { headers: { Cookie: cookie } },
      env
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("browser-canary");
    expect(api.getSongUrl).not.toHaveBeenCalled();
    expect(api.proxyNeteaseAudio).not.toHaveBeenCalled();
  });

  it("recursively redacts credentials from non-capability responses", async () => {
    const env = createEnv();
    api.getPlaylistDetail.mockResolvedValue({
      message: "internal upstream detail at https://secret.example",
      data: {
        nested: {
          note: "MUSIC_U=canary-response",
          authorization: "Bearer canary-response",
        },
      },
    });
    const response = await neteaseRoutes.request(
      "/playlist",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://music.example",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ playlistId: "1" }),
      },
      env
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("[redacted]");
    expect(text).toContain("NetEase response received");
    expect(text).not.toContain("secret.example");
    expect(text).not.toContain("canary-response");
    expect(text.toLowerCase()).not.toContain("authorization");
  });

  it("uses a fixed audio error instead of returning an exception message", async () => {
    const env = createEnv();
    const { cookie } = await qrLogin(env);
    api.getSongUrl.mockRejectedValue(
      new Error("upstream URL had MUSIC_U=canary-exception")
    );
    const response = await neteaseRoutes.request(
      "/audio?id=1&br=320000",
      {
        headers: { Cookie: cookie },
      },
      env
    );
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toBe('{"error":"NetEase audio upstream failed"}');
    expect(text).not.toContain("canary-exception");
  });

  it("does not echo the upstream QR message", async () => {
    const env = createEnv();
    api.checkQrStatus.mockResolvedValue({
      data: { code: 801, message: "MUSIC_U=canary-qr-message" },
    });
    const response = await neteaseRoutes.request(
      "/login/qr/check",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "qr-key-1234" }),
      },
      env
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("Waiting for scan");
    expect(text).not.toContain("canary-qr-message");
  });

  it("sanitizes profile data before response and session storage", async () => {
    const env = createEnv();
    api.checkQrStatus.mockResolvedValue({
      data: { code: 803 },
      cookie: "MUSIC_U=real-secret; __csrf=csrf-secret",
    });
    api.getMyInfo.mockResolvedValue({
      data: {
        profile: { ...profile, signature: "MUSIC_U=canary-profile" },
      },
    });

    const response = await neteaseRoutes.request(
      "/login/qr/check",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "qr-key-1234" }),
      },
      env
    );
    const text = await response.text();
    const stored = [...(env.SESSION_KV as MemoryKv).values.values()][0];

    expect(response.status).toBe(200);
    expect(text).not.toContain("canary-profile");
    expect(stored).not.toContain("canary-profile");
  });

  it("strictly validates public playlist input and request source", async () => {
    const env = createEnv();
    api.getPlaylistDetail.mockResolvedValue({
      id: 7,
      trackIds: [],
      tracks: [],
    });

    for (const body of [
      { playlistId: "" },
      { playlistId: "7 OR 1=1" },
      { playlistId: "7", extra: true },
      { playlistId: "9".repeat(21) },
    ]) {
      const response = await neteaseRoutes.request(
        "/playlist",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://music.example",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify(body),
        },
        env
      );
      expect(response.status).toBe(400);
    }

    for (const headers of [
      { "Content-Type": "application/json" },
      { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
      {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "same-origin",
      },
    ]) {
      const crossSite = await neteaseRoutes.request(
        "/playlist",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ playlistId: "7" }),
        },
        env
      );
      expect(crossSite.status).toBe(403);
    }
    expect(api.getPlaylistDetail).not.toHaveBeenCalled();
  });

  it("rate limits public playlist expansion and fails closed without KV", async () => {
    const env = createEnv();
    api.getPlaylistDetail.mockResolvedValue({
      id: 7,
      trackIds: [],
      tracks: [],
    });
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://music.example",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ playlistId: "7" }),
    };

    for (let index = 0; index < 12; index += 1) {
      const response = await neteaseRoutes.request("/playlist", init, env);
      expect(response.status).toBe(200);
    }
    const blocked = await neteaseRoutes.request("/playlist", init, env);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(api.getPlaylistDetail).toHaveBeenCalledTimes(12);

    const unavailableEnv = {
      ...createEnv(),
      oh_file_url: {
        get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
      },
    } as unknown as Env;
    api.getPlaylistDetail.mockClear();
    const unavailable = await neteaseRoutes.request(
      "/playlist",
      init,
      unavailableEnv
    );
    expect(unavailable.status).toBe(503);
    expect(api.getPlaylistDetail).not.toHaveBeenCalled();
  });

  it("rejects unbounded search and pagination fields instead of coercing", async () => {
    const env = createEnv();
    for (const body of [
      { keyword: "x".repeat(101), page: 1, limit: 20 },
      { keyword: "valid", page: "1", limit: 20 },
      { keyword: "valid", page: 101, limit: 20 },
      { keyword: "valid", page: 1, limit: 51 },
      { keyword: "valid", type: 2, page: 1, limit: 20 },
    ]) {
      const response = await neteaseRoutes.request(
        "/search",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        env
      );
      expect(response.status).toBe(400);
    }
    expect(api.search).not.toHaveBeenCalled();

    const comments = await neteaseRoutes.request(
      "/comments/new",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "1", pageNo: 1, pageSize: 101 }),
      },
      env
    );
    expect(comments.status).toBe(400);
    expect(api.getNewComments).not.toHaveBeenCalled();
  });
});
