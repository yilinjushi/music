// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKV } from "./sqlite-kv";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("SqliteKV", () => {
  it("preserves JSON, metadata and expiration across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "otter-music-kv-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "session.sqlite");
    const expiresAt = Math.floor(Date.now() / 1000) + 120;

    const first = new SqliteKV(filePath, "session");
    await first.put(
      "session:one",
      JSON.stringify({ version: 1, safe: true }),
      { expiration: expiresAt, metadata: { version: 1 } }
    );
    first.close();

    const reopened = new SqliteKV(filePath, "session");
    await expect(
      reopened.get("session:one", { type: "json" })
    ).resolves.toEqual({ version: 1, safe: true });
    await expect(
      reopened.getWithMetadata<{ version: number }>("session:one", {
        type: "json",
      })
    ).resolves.toMatchObject({ metadata: { version: 1 } });
    expect(reopened.quickCheck()).toEqual(["ok"]);
    reopened.close();
  });

  it("does not return expired values and paginates by prefix", async () => {
    const store = new SqliteKV(":memory:", "rate");
    await store.put("request:a", "1");
    await store.put("request:b", "2");
    await store.put("other:c", "3");
    await store.put("expired", "gone", {
      expiration: Math.floor(Date.now() / 1000) - 1,
    });

    await expect(store.get("expired")).resolves.toBeNull();
    await expect(store.list({ prefix: "request:", limit: 1 })).resolves.toEqual(
      expect.objectContaining({
        keys: [{ name: "request:a" }],
        list_complete: false,
        cursor: "request:a",
      })
    );
    await expect(
      store.list({ prefix: "request:", limit: 1, cursor: "request:a" })
    ).resolves.toEqual(
      expect.objectContaining({
        keys: [{ name: "request:b" }],
        list_complete: true,
      })
    );
    store.close();
  });

  it("atomically enforces a fixed-window limit under concurrent callers", async () => {
    const store = new SqliteKV(":memory:", "rate");
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        store.consumeFixedWindow("rate:key", 7, 60)
      )
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(7);
    expect(results.filter((result) => !result.allowed)).toHaveLength(33);
    await expect(store.get("rate:key")).resolves.toBe("7");
    store.close();
  });
});
