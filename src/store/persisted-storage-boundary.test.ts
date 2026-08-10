import { describe, expect, it, vi } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  createHistoryStateStorage,
  HISTORY_STORE_VERSION,
} from "./history-store";
import { createMusicStateStorage, MUSIC_STORE_VERSION } from "./music-store";

function memoryStorage(initial: string): StateStorage & {
  read: () => string | null;
} {
  let value: string | null = initial;
  return {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_name, next) => {
      value = next;
    }),
    removeItem: vi.fn(async () => {
      value = null;
    }),
    read: () => value,
  };
}

const safeTrack = {
  id: "safe",
  name: "Safe",
  artist: ["Artist"],
  album: "Album",
  pic_id: "",
  url_id: "safe",
  lyric_id: "safe",
  source: "netease",
};

describe("current-version persisted storage boundaries", () => {
  it("rewrites contaminated history envelopes before hydration", async () => {
    const base = memoryStorage(
      JSON.stringify({
        state: {
          history: [
            safeTrack,
            { ...safeTrack, id: "unsafe", cookie: "MUSIC_U=history-canary" },
          ],
          unknown: "drop-me",
        },
        version: HISTORY_STORE_VERSION,
      })
    );
    const storage = createHistoryStateStorage(base);

    const clean = await storage.getItem("history");

    expect(clean).not.toContain("history-canary");
    expect(base.read()).toBe(clean);
    expect(JSON.parse(clean!)).toEqual({
      state: { history: [safeTrack] },
      version: HISTORY_STORE_VERSION,
    });
  });

  it("rewrites contaminated music envelopes before hydration", async () => {
    const base = memoryStorage(
      JSON.stringify({
        state: {
          favorites: [safeTrack],
          queue: [
            safeTrack,
            { ...safeTrack, id: "unsafe", token: "music-store-canary" },
          ],
          playlists: [],
          arbitraryCredential: "MUSIC_U=music-canary",
        },
        version: MUSIC_STORE_VERSION,
      })
    );
    const storage = createMusicStateStorage(base);

    const clean = await storage.getItem("music");

    expect(clean).not.toContain("music-store-canary");
    expect(clean).not.toContain("music-canary");
    expect(base.read()).toBe(clean);
    expect(JSON.parse(clean!)).toEqual({
      state: {
        favorites: [safeTrack],
        queue: [safeTrack],
        playlists: [],
      },
      version: MUSIC_STORE_VERSION,
    });
  });
});
