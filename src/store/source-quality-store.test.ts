import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/storage-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-adapter")>();
  return {
    ...actual,
    idbStorage: {
      getItem: async (name: string) => memory.get(name) ?? null,
      setItem: async (name: string, value: string) => {
        memory.set(name, value);
      },
      removeItem: async (name: string) => {
        memory.delete(name);
      },
    },
  };
});

import { useSourceQualityStore } from "./source-quality-store";

describe("source quality store persistence", () => {
  beforeEach(() => {
    memory.clear();
    useSourceQualityStore.setState({ stats: {} });
  });

  it("cleans a direct state bypass before the next action and persist", () => {
    useSourceQualityStore.setState({
      stats: {
        netease: {
          recent: [true, false, true],
          fails: 1,
          x_api_key: "quality-canary",
        },
        "unknown-source": {
          recent: [true],
          fails: 1,
          wsSecret: "quality-canary",
        },
      },
    } as never);

    useSourceQualityStore.getState().recordSuccess("netease");
    const state = useSourceQualityStore.getState();
    expect(state.stats).toEqual({
      netease: { recent: [true, false, true, true], fails: 0 },
    });

    const partialize = useSourceQualityStore.persist.getOptions().partialize!;
    expect(partialize(state)).toEqual({ stats: state.stats });
    expect(JSON.stringify(state.stats)).not.toContain("quality-canary");
  });
});
