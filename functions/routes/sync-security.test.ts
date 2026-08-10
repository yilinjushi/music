// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { KVNamespace } from "../types/hono";
import { app } from "../app";
import { syncRoutes } from "./sync";
import { syncRoutesV2 } from "./sync-v2";

const RETIRED_BODY = {
  success: false,
  data: null,
  message: "Remote sync is retired",
};

class RejectKvAccess implements KVNamespace {
  calls: string[] = [];

  private reject(method: string): never {
    this.calls.push(method);
    throw new Error(`retired sync touched KV via ${method}`);
  }

  async get(): Promise<never> {
    return this.reject("get");
  }

  async put(): Promise<never> {
    return this.reject("put");
  }

  async delete(): Promise<never> {
    return this.reject("delete");
  }

  async list(): Promise<never> {
    return this.reject("list");
  }

  async getWithMetadata<T>(): Promise<{ value: never; metadata: T | null }> {
    return this.reject("getWithMetadata");
  }
}

function expectPrivateRetirement(response: Response) {
  expect(response.status).toBe(410);
  expect(response.headers.get("cache-control")).toBe(
    "private, no-store, max-age=0"
  );
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("vary")?.toLowerCase()).toContain(
    "authorization"
  );
  expect(response.headers.get("vary")?.toLowerCase()).toContain("cookie");
}

describe.each([
  ["sync v1", syncRoutes, ["/", "/check", "/create-key", "/keys"]],
  ["sync v2", syncRoutesV2, ["/", "/check", "/pull", "/create-key", "/keys"]],
] as const)("%s retirement boundary", (_name, routes, paths) => {
  it.each(paths)(
    "returns a fixed private 410 for GET %s without KV",
    async (path) => {
      const kv = new RejectKvAccess();
      const response = await routes.request(
        `https://music.example${path}`,
        { headers: { Authorization: "Bearer retired-key" } },
        { oh_file_url: kv } as never
      );

      expectPrivateRetirement(response);
      await expect(response.json()).resolves.toEqual(RETIRED_BODY);
      expect(kv.calls).toEqual([]);
    }
  );

  it.each(paths)(
    "returns a fixed private 410 for POST %s without reading the body or KV",
    async (path) => {
      const kv = new RejectKvAccess();
      const response = await routes.request(
        `https://music.example${path}`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer retired-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            data: {
              favorites: [{ note: "MUSIC_U=must-never-be-processed" }],
              playlists: [],
            },
          }),
        },
        { oh_file_url: kv } as never
      );

      expectPrivateRetirement(response);
      await expect(response.json()).resolves.toEqual(RETIRED_BODY);
      expect(kv.calls).toEqual([]);
    }
  );

  it("fails closed under concurrent writes without a process-local mutex", async () => {
    const kv = new RejectKvAccess();
    const requests = Array.from({ length: 8 }, (_, index) =>
      routes.request(
        "https://music.example/",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer retired-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            data: { favorites: [{ id: String(index) }], playlists: [] },
          }),
        },
        { oh_file_url: kv } as never
      )
    );

    const responses = await Promise.all(requests);
    expect(responses.map(({ status }) => status)).toEqual(
      Array.from({ length: 8 }, () => 410)
    );
    expect(kv.calls).toEqual([]);
  });
});

describe("retired sync destructive endpoints", () => {
  it.each([
    [syncRoutes, "/keys/retired-key"],
    [syncRoutesV2, "/keys/retired-key"],
  ] as const)("returns 410 for DELETE %s without KV", async (routes, path) => {
    const kv = new RejectKvAccess();
    const response = await routes.request(
      `https://music.example${path}`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer retired-key" },
      },
      { oh_file_url: kv } as never
    );

    expectPrivateRetirement(response);
    expect(kv.calls).toEqual([]);
  });
});

describe("production route mounting", () => {
  it("mounts the retired sync boundary and leaves admin authentication unmounted", async () => {
    const kv = new RejectKvAccess();
    const env = {
      APP_ORIGIN: "https://music.example",
      oh_file_url: kv,
      SESSION_KV: kv,
      NETEASE_SESSION_HMAC_SECRET: "unused-retirement-test-secret",
      NETEASE_CREDENTIAL_ENC_KEY: "unused-retirement-test-secret",
    };

    const sync = await app.request(
      "https://music.example/sync/v2",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { favorites: [], playlists: [] } }),
      },
      env
    );
    const adminLogin = await app.request(
      "https://music.example/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "must-not-be-processed" }),
      },
      env
    );

    expectPrivateRetirement(sync);
    await expect(sync.json()).resolves.toEqual(RETIRED_BODY);
    expect(adminLogin.status).toBe(404);
    expect(kv.calls).toEqual([]);
  });
});
