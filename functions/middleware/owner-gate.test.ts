import { describe, expect, it } from "vitest";
import { app } from "../app";
import type { Env, KVNamespace } from "../types/hono";
import {
  NETEASE_SESSION_COOKIE,
  createNeteaseSession,
  readNeteaseSession,
} from "../utils/netease-session";

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

// sha256("netease-owner:42")
const OWNER_HASH =
  "b5459f3214ec6fc5daf51c88eba7969496cf0331f58e3177e760ccd91d1742f8";

function createEnv(owner: string | undefined = OWNER_HASH): Env {
  return {
    APP_ORIGIN: "https://music.example",
    oh_file_url: new MemoryKv(),
    SESSION_KV: new MemoryKv(),
    NETEASE_SESSION_HMAC_SECRET: "hmac-secret-32-characters-minimum-value",
    NETEASE_CREDENTIAL_ENC_KEY: "aes-secret-32-characters-minimum-value!",
    OWNER_NETEASE_UID_SHA256: owner,
  } as Env;
}

const profile = (userId: number) => ({
  userId,
  nickname: "x",
  avatarUrl: "https://example.com/a.jpg",
});

async function cookieFor(env: Env, userId: number) {
  const { token } = await createNeteaseSession(
    env,
    "MUSIC_U=abc; __csrf=1",
    profile(userId)
  );
  return `${NETEASE_SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

const audioUrl = `https://music.example/music-api/cache/audio?key=${"a".repeat(64)}`;

describe("owner-only gate", () => {
  it.each([
    "/music-api/cache/audio?key=" + "a".repeat(64),
    "/music-api/?source=netease&name=x",
    "/proxy?url=https://example.com/a.mp3",
    "/music-api/netease/search",
  ])("rejects anonymous access to %s", async (path) => {
    const res = await app.request(
      `https://music.example${path}`,
      { method: path.includes("netease/search") ? "POST" : "GET" },
      createEnv()
    );
    expect(res.status).toBe(401);
  });

  it("lets the owner's session through", async () => {
    const env = createEnv();
    const cookie = await cookieFor(env, 42);
    const res = await app.request(
      audioUrl,
      { headers: { Cookie: cookie } },
      env
    );
    expect(res.status).not.toBe(401);
  });

  it("rejects another account's session and deletes it", async () => {
    const env = createEnv();
    const cookie = await cookieFor(env, 7);
    const res = await app.request(
      audioUrl,
      { headers: { Cookie: cookie } },
      env
    );
    expect(res.status).toBe(401);
    expect(await readNeteaseSession(env, cookie)).toBeNull();
  });

  it("denies everyone when the owner is not configured", async () => {
    const env = createEnv("");
    const cookie = await cookieFor(env, 42);
    const res = await app.request(
      audioUrl,
      { headers: { Cookie: cookie } },
      env
    );
    expect(res.status).toBe(401);
  });

  it("keeps the login flow and health check reachable", async () => {
    const env = createEnv();
    const me = await app.request(
      "https://music.example/music-api/netease/session/me",
      {},
      env
    );
    expect(me.status).toBe(401); // from the route itself: "no session"
    expect(await me.json()).toEqual({ authenticated: false });
    const health = await app.request("https://music.example/health", {}, env);
    expect(health.status).toBe(200);
  });
});
