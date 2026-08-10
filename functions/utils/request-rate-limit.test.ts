import { describe, expect, it } from "vitest";
import type { KVNamespace } from "../types/hono";
import {
  checkFixedWindowRateLimit,
  requestClientId,
} from "./request-rate-limit";

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

  async getWithMetadata() {
    return { value: null, metadata: null };
  }
}

describe("request rate limiting", () => {
  it("uses only Cloudflare's client address header", () => {
    expect(
      requestClientId(
        new Headers({
          "CF-Connecting-IP": "203.0.113.7",
          "X-Forwarded-For": "127.0.0.1",
        })
      )
    ).toBe("203.0.113.7");
    expect(
      requestClientId(new Headers({ "X-Forwarded-For": "127.0.0.1" }))
    ).toBe("unknown");
  });

  it("blocks after the configured number of requests", async () => {
    const kv = new MemoryKv();
    const now = 1_700_000_000_000;
    expect(
      (await checkFixedWindowRateLimit(kv, "proxy", "client", 2, 60, now))
        .allowed
    ).toBe(true);
    expect(
      (await checkFixedWindowRateLimit(kv, "proxy", "client", 2, 60, now))
        .allowed
    ).toBe(true);
    const blocked = await checkFixedWindowRateLimit(
      kv,
      "proxy",
      "client",
      2,
      60,
      now
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("serializes concurrent requests for the same isolate key", async () => {
    const kv = new MemoryKv();
    const now = 1_700_000_000_000;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        checkFixedWindowRateLimit(kv, "playlist", "same-client", 3, 60, now)
      )
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(results.filter((result) => !result.allowed)).toHaveLength(17);
  });
});
