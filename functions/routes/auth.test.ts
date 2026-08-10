// @vitest-environment node
import { describe, expect, it } from "vitest";
import { authRoutes } from "./auth";
import type { KVNamespace } from "../types/hono";

class MemoryKv implements KVNamespace {
  private values = new Map<string, string>();

  async get(key: string, options?: { type?: string }) {
    const value = this.values.get(key) ?? null;
    if (value && options?.type === "json") return JSON.parse(value);
    return value;
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

function request(password: string, env: Record<string, unknown>) {
  return authRoutes.request(
    "https://music.example/login",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.10",
      },
      body: JSON.stringify({ password }),
    },
    env as never
  );
}

describe("admin authentication", () => {
  it("fails closed when independent secrets are missing", async () => {
    const response = await request("password", {
      oh_file_url: new MemoryKv(),
      PASSWORD: "a-valid-long-password",
    });
    expect(response.status).toBe(503);
  });

  it("sets only a secure HttpOnly cookie and returns no JWT", async () => {
    const response = await request("a-valid-long-password", {
      oh_file_url: new MemoryKv(),
      PASSWORD: "a-valid-long-password",
      ADMIN_SESSION_SECRET: "independent-session-secret-at-least-32-characters",
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") || "";
    expect(cookie).toContain("__Host-music_admin=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain("token");
  });

  it("rate limits repeated failed logins", async () => {
    const environment = {
      oh_file_url: new MemoryKv(),
      PASSWORD: "a-valid-long-password",
      ADMIN_SESSION_SECRET: "independent-session-secret-at-least-32-characters",
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request("wrong", environment)).status).toBe(401);
    }
    const limited = await request("wrong", environment);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
  });
});
