import { describe, expect, it } from "vitest";
import type { UserProfile } from "./music/netease-types";
import type { Env, KVNamespace } from "../types/hono";
import {
  NETEASE_SESSION_COOKIE,
  createNeteaseSession,
  deleteNeteaseSession,
  readNeteaseSession,
  renewNeteaseSession,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
} from "./netease-session";

class MemoryKv implements KVNamespace {
  values = new Map<string, string>();
  putOptions = new Map<string, unknown>();

  async get(key: string, options?: { type?: string }) {
    const value = this.values.get(key) ?? null;
    return options?.type === "json" && value ? JSON.parse(value) : value;
  }

  async put(key: string, value: string, options?: unknown) {
    this.values.set(key, value);
    this.putOptions.set(key, options);
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

const profile: UserProfile = {
  userId: 42,
  nickname: "Session Tester",
  avatarUrl: "https://example.com/avatar.jpg",
};

function createEnv() {
  const kv = new MemoryKv();
  const env: Env = {
    APP_ORIGIN: "https://music.example",
    oh_file_url: new MemoryKv(),
    SESSION_KV: kv,
    NETEASE_SESSION_HMAC_SECRET: "hmac-secret-32-characters-minimum-value",
    NETEASE_CREDENTIAL_ENC_KEY: "aes-secret-32-characters-minimum-value!",
    OWNER_NETEASE_UID_SHA256:
      "b5459f3214ec6fc5daf51c88eba7969496cf0331f58e3177e760ccd91d1742f8",
    NETEASE_SESSION_TTL_SECONDS: "7200",
  };
  return { env, kv };
}

function cookieHeader(token: string) {
  return `${NETEASE_SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

describe("NetEase server-side session", () => {
  it("stores only AES-GCM ciphertext and recovers the credential", async () => {
    const { env, kv } = createEnv();
    const credential = "MUSIC_U=top-secret; __csrf=csrf-secret";

    const created = await createNeteaseSession(env, credential, profile, 1000);
    const rawRecord = [...kv.values.values()][0];

    expect(rawRecord).not.toContain("top-secret");
    expect(rawRecord).not.toContain("MUSIC_U");
    expect(rawRecord).toContain("ciphertext");
    expect([...kv.putOptions.values()][0]).toEqual({ expirationTtl: 7200 });

    const session = await readNeteaseSession(
      env,
      cookieHeader(created.token),
      2000
    );
    expect(session?.credential).toBe(credential);
    expect(session?.profile).toEqual(profile);
  });

  it("rejects a tampered HMAC token", async () => {
    const { env } = createEnv();
    const created = await createNeteaseSession(
      env,
      "MUSIC_U=top-secret",
      profile
    );
    const [id, signature] = created.token.split(".");
    const replacement = signature[0] === "A" ? "B" : "A";
    const tampered = `${id}.${replacement}${signature.slice(1)}`;

    await expect(
      readNeteaseSession(env, cookieHeader(tampered))
    ).resolves.toBeNull();
  });

  it("fails closed when signing and encryption secrets are identical", async () => {
    const { env, kv } = createEnv();
    const created = await createNeteaseSession(
      env,
      "MUSIC_U=top-secret",
      profile
    );
    env.NETEASE_CREDENTIAL_ENC_KEY = env.NETEASE_SESSION_HMAC_SECRET;

    await expect(
      createNeteaseSession(env, "MUSIC_U=another-secret", profile)
    ).rejects.toThrow("must be different");
    await expect(
      readNeteaseSession(env, cookieHeader(created.token))
    ).rejects.toThrow("must be different");
    await expect(readNeteaseSession(env, undefined)).rejects.toThrow(
      "must be different"
    );
    await expect(
      deleteNeteaseSession(env, cookieHeader(created.token))
    ).rejects.toThrow("must be different");
    expect(kv.values.size).toBe(1);
  });

  it("expires and revokes sessions", async () => {
    const { env, kv } = createEnv();
    const first = await createNeteaseSession(
      env,
      "MUSIC_U=first-secret",
      profile,
      1000
    );
    await expect(
      readNeteaseSession(env, cookieHeader(first.token), 7_202_000)
    ).resolves.toBeNull();
    expect(kv.values.size).toBe(0);

    const second = await createNeteaseSession(
      env,
      "MUSIC_U=second-secret",
      profile
    );
    await deleteNeteaseSession(env, cookieHeader(second.token));
    await expect(
      readNeteaseSession(env, cookieHeader(second.token))
    ).resolves.toBeNull();
  });

  it("emits a host-only hardened opaque cookie", async () => {
    const { env } = createEnv();
    const created = await createNeteaseSession(
      env,
      "MUSIC_U=top-secret",
      profile
    );
    const serialized = serializeSessionCookie(created.token, created.maxAge);

    expect(serialized).toContain(`${NETEASE_SESSION_COOKIE}=`);
    expect(serialized).toContain("Path=/");
    expect(serialized).toContain("HttpOnly");
    expect(serialized).toContain("Secure");
    expect(serialized).toContain("SameSite=Strict");
    expect(serialized).not.toContain("Domain=");
    expect(serialized).not.toContain("MUSIC_U");
    expect(serializeExpiredSessionCookie()).toContain("Max-Age=0");
  });

  it("slides an active session's expiry forward at most once a day", async () => {
    const { env } = createEnv();
    env.NETEASE_SESSION_TTL_SECONDS = String(400 * 24 * 60 * 60);
    const day = 24 * 60 * 60 * 1000;
    const created = await createNeteaseSession(env, "MUSIC_U=x", profile, 0);
    const header = cookieHeader(created.token);

    expect(created.maxAge).toBe(400 * 24 * 60 * 60);
    await expect(renewNeteaseSession(env, header, day / 2)).resolves.toBeNull();
    await expect(renewNeteaseSession(env, header, 30 * day)).resolves.toBe(
      400 * 24 * 60 * 60
    );
    const session = await readNeteaseSession(env, header, 30 * day);
    expect(session?.expiresAt).toBe(430 * day);
  });
});
