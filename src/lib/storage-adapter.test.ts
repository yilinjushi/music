import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StateStorage } from "zustand/middleware";

const idb = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("idb-keyval", () => idb);

import { createSanitizingStateStorage, idbStorage } from "./storage-adapter";

describe("storage adapter persistence boundary", () => {
  beforeEach(() => {
    localStorage.clear();
    idb.del.mockReset().mockResolvedValue(undefined);
    idb.get.mockReset().mockResolvedValue(undefined);
    idb.set.mockReset().mockResolvedValue(undefined);
  });

  it("does not copy a legacy localStorage blob before its owner sanitizes it", async () => {
    const raw = JSON.stringify({
      state: { safe: "kept", cookie: "MUSIC_U=legacy-canary" },
      version: 0,
    });
    localStorage.setItem("legacy-store", raw);

    await expect(idbStorage.getItem("legacy-store")).resolves.toBe(raw);
    expect(idb.set).not.toHaveBeenCalled();
    expect(localStorage.getItem("legacy-store")).toBe(raw);

    const clean = JSON.stringify({ state: { safe: "kept" }, version: 2 });
    await idbStorage.setItem("legacy-store", clean);
    expect(idb.set).toHaveBeenCalledWith("legacy-store", clean);
    expect(localStorage.getItem("legacy-store")).toBeNull();
  });

  it("rewrites current-version pollution and sanitizes every later write", async () => {
    let raw = JSON.stringify({
      state: { safe: "kept", x_auth_token: "current-version-canary" },
      version: 7,
    });
    const base: StateStorage = {
      getItem: vi.fn(async () => raw),
      setItem: vi.fn(async (_name, value) => {
        raw = value;
      }),
      removeItem: vi.fn(async () => undefined),
    };
    const storage = createSanitizingStateStorage(base, {
      version: 7,
      sanitize: (value) => {
        const candidate = value as { safe?: unknown } | null;
        return {
          safe: typeof candidate?.safe === "string" ? candidate.safe : "",
        };
      },
    });

    const hydrated = await storage.getItem("safe-store");
    expect(hydrated).toBe(
      JSON.stringify({ state: { safe: "kept" }, version: 7 })
    );
    expect(raw).not.toContain("current-version-canary");

    await storage.setItem(
      "safe-store",
      JSON.stringify({
        state: { safe: "next", wsSecret: "write-canary" },
        version: 7,
      })
    );
    expect(raw).toBe(JSON.stringify({ state: { safe: "next" }, version: 7 }));
    expect(raw).not.toContain("write-canary");
  });
});
