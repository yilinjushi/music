import { beforeEach, describe, expect, it, vi } from "vitest";
import { aggregatedSourceOptions, DEFAULT_SOURCE_CONFIGS } from "@/types/music";
import { LxKuwoProvider } from "@/lib/music-provider/providers/lx-kuwo-provider";
import { LxQqProvider } from "@/lib/music-provider/providers/lx-qq-provider";

const mockedFetch = vi.fn();
global.fetch = mockedFetch;

import { getLxUrl } from "./lx-api";

describe("getLxUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed without putting provider credentials in browser requests", async () => {
    await expect(getLxUrl("lx_kuwo", "550531860", 320)).resolves.toBeNull();
    await expect(getLxUrl("lx_qq", "0039MnYb0qxYhV", 128)).resolves.toBeNull();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("hides unavailable LX sources from selectable and persisted defaults", () => {
    const selectableSources = aggregatedSourceOptions.map(({ value }) => value);
    const defaultSources = DEFAULT_SOURCE_CONFIGS.map(({ source }) => source);

    expect(selectableSources).not.toContain("lx_kuwo");
    expect(selectableSources).not.toContain("lx_qq");
    expect(defaultSources).not.toContain("lx_kuwo");
    expect(defaultSources).not.toContain("lx_qq");
  });

  it.each([
    [new LxKuwoProvider(), "lx_kuwo"],
    [new LxQqProvider(), "lx_qq"],
  ] as const)("keeps the %s provider fail-closed", async (provider, source) => {
    expect(provider.source).toBe(source);
    await expect(provider.search("test", 1, 20)).resolves.toEqual({
      items: [],
      hasMore: false,
    });
    await expect(
      provider.getUrl({
        id: `${provider.source}_legacy`,
        name: "Legacy",
        artist: ["Artist"],
        album: "Album",
        pic_id: "",
        url_id: "legacy-id",
        lyric_id: "legacy-id",
        source: provider.source,
      })
    ).resolves.toBeNull();
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
