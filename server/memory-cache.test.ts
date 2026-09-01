// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MemoryResponseCache } from "./memory-cache";

describe("MemoryResponseCache", () => {
  it("returns independent response bodies and evicts the oldest entry", async () => {
    const cache = new MemoryResponseCache({
      maxEntries: 1,
      maxBytes: 1024,
      maxItemBytes: 1024,
    });
    const firstRequest = new Request("https://music.example/one");
    const secondRequest = new Request("https://music.example/two");

    await cache.put(
      firstRequest,
      new Response("first", {
        headers: { "Cache-Control": "public, max-age=60" },
      })
    );
    await cache.put(
      secondRequest,
      new Response("second", {
        headers: { "Cache-Control": "public, max-age=60" },
      })
    );

    await expect(cache.match(firstRequest)).resolves.toBeNull();
    const response = await cache.match(secondRequest);
    expect(response).not.toBeNull();
    expect(await response!.text()).toBe("second");
    expect(cache.size).toBe(1);
  });

  it("rejects an item larger than its configured bound", async () => {
    const cache = new MemoryResponseCache({ maxItemBytes: 4, maxBytes: 16 });
    await expect(
      cache.put(
        new Request("https://music.example/large"),
        new Response("0123456789")
      )
    ).rejects.toThrow("bounded size");
    expect(cache.size).toBe(0);
  });
});
