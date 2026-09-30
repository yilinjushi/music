import { afterEach, describe, expect, it, vi } from "vitest";
import { hasOfflineAudio } from "@/lib/offline-audio";

describe("hasOfflineAudio", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is true only when the song file is stored on the phone", async () => {
    const match = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal("caches", { open: async () => ({ match }) });

    const track = { id: "123", source: "netease" } as const;
    expect(await hasOfflineAudio(track)).toBe(true);
    expect(await hasOfflineAudio(track)).toBe(false);
    expect(match.mock.calls[0][0]).toMatch(
      /^\/music-api\/cache\/audio\?key=[a-f0-9]{64}$/
    );
  });

  it("is false for songs that can never be stored offline", async () => {
    vi.stubGlobal("caches", { open: async () => ({ match: vi.fn() }) });
    expect(await hasOfflineAudio({ id: "x", source: "local" })).toBe(false);
  });
});
