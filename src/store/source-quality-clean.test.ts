import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  SOURCE_QUALITY_STORE_VERSION,
  createSourceQualityStateStorage,
  sanitizePersistedSourceQualityState,
} from "./source-quality-clean";

describe("source quality persistence schema", () => {
  it("picks known sources and bounded stats only", () => {
    const clean = sanitizePersistedSourceQualityState({
      stats: {
        netease: {
          recent: [...Array(22).fill(true), false, "not-a-boolean"],
          fails: 900,
          wsSecret: "strip-me",
        },
        "unknown-source": { recent: [true], fails: 1 },
      },
      session_id: "strip-me",
    });

    expect(clean).toEqual({
      stats: {
        netease: { recent: [...Array(19).fill(true), false], fails: 20 },
      },
    });
    expect(JSON.stringify(clean)).not.toContain("strip-me");
  });

  it("rewrites current-version contamination before hydration", async () => {
    let raw = JSON.stringify({
      state: {
        stats: {
          qq: {
            recent: [true, false, true],
            fails: 1,
            x_api_key: "stats-canary",
          },
        },
        wsSecret: "state-canary",
      },
      version: SOURCE_QUALITY_STORE_VERSION,
    });
    const base: StateStorage = {
      getItem: () => raw,
      setItem: (_key, value) => {
        raw = value;
      },
      removeItem: () => undefined,
    };
    const storage = createSourceQualityStateStorage(base);

    const clean = await storage.getItem("oh_source_quality_store_v2");
    expect(clean).toBe(raw);
    expect(raw).toBe(
      JSON.stringify({
        state: {
          stats: { qq: { recent: [true, false, true], fails: 1 } },
        },
        version: SOURCE_QUALITY_STORE_VERSION,
      })
    );
    expect(raw).not.toMatch(/canary/i);
  });
});
