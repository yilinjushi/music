import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sanitizePersistedMusicState,
  useMusicStore,
} from "./music-store/index";
import type { MusicTrack } from "@/types/music";

vi.mock("@/lib/storage-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage-adapter")>();
  return {
    ...actual,
    idbStorage: {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("@/lib/utils/toast", () => ({
  toastUtils: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

const track = (id: string): MusicTrack => ({
  id,
  name: `Song ${id}`,
  artist: ["Artist"],
  album: "Album",
  pic_id: "cover",
  url_id: "https://media.example/song.mp3",
  lyric_id: "lyric",
  source: "url",
});

const unsafeTrack = (id: string): MusicTrack =>
  ({
    ...track(id),
    arbitrary: { nested: "Cookie%253DMUSIC_U-canary" },
  }) as MusicTrack;

describe("persistent music-store ingress", () => {
  beforeEach(() => {
    useMusicStore.setState({
      favorites: [],
      playlists: [],
      queue: [],
      originalQueue: [],
      currentIndex: 0,
    });
  });

  it("keeps persist middleware initialized with isolated storage I/O", () => {
    expect(useMusicStore.persist).toBeDefined();
    expect(useMusicStore.persist.getOptions().storage).toBeDefined();
  });

  it("rejects unsafe favorite, playlist, and queue writes", () => {
    expect(useMusicStore.getState().addToFavorites(unsafeTrack("fav"))).toMatch(
      /不安全/
    );
    const playlistId = useMusicStore.getState().createPlaylist("Safe list");
    useMusicStore
      .getState()
      .setPlaylistTracks(playlistId, [track("safe"), unsafeTrack("bad")]);
    useMusicStore.getState().playContext([unsafeTrack("queue")]);

    expect(useMusicStore.getState().favorites).toEqual([]);
    expect(
      useMusicStore.getState().playlists.find((p) => p.id === playlistId)
        ?.tracks
    ).toEqual([expect.objectContaining({ id: "safe" })]);
    expect(useMusicStore.getState().queue).toEqual([]);
  });

  it("one-time migration drops contaminated tracks but preserves safe user data", () => {
    const migrated = sanitizePersistedMusicState({
      favorites: [track("safe-favorite"), unsafeTrack("bad-favorite")],
      playlists: [
        {
          id: "playlist-1",
          name: "Kept playlist",
          createdAt: 1,
          tracks: [track("safe-track"), unsafeTrack("bad-track")],
        },
      ],
      queue: [unsafeTrack("bad-queue")],
      volume: 0.42,
      lastMineTab: "created",
    });

    expect(migrated.favorites).toEqual([
      expect.objectContaining({ id: "safe-favorite" }),
    ]);
    expect(migrated.playlists).toEqual([
      expect.objectContaining({
        id: "playlist-1",
        name: "Kept playlist",
        tracks: [expect.objectContaining({ id: "safe-track" })],
      }),
    ]);
    expect(migrated.queue).toEqual([]);
    expect(migrated.volume).toBe(0.42);
    expect(migrated.lastMineTab).toBe("created");
  });

  it("filters unsafe tracks even when a caller bypasses actions with setState", () => {
    useMusicStore.setState({
      favorites: [unsafeTrack("direct-bypass")],
      queue: [unsafeTrack("direct-queue")],
    });
    const partialize = useMusicStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");

    const persisted = partialize!(useMusicStore.getState()) as {
      favorites: MusicTrack[];
      queue: MusicTrack[];
    };
    expect(persisted.favorites).toEqual([]);
    expect(persisted.queue).toEqual([]);
  });

  it("persists only validated settings and explicit source config fields", () => {
    useMusicStore.setState({
      bilibiliAutoMatchSuffix: "secret=four-pass-canary",
      sourceConfigs: [
        {
          source: "netease",
          enabled: true,
          visible: true,
          unknownProviderField: "must-not-persist",
        },
      ],
    } as never);

    const partialize = useMusicStore.persist.getOptions().partialize!;
    const persisted = partialize(useMusicStore.getState()) as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty("bilibiliAutoMatchSuffix");
    expect(persisted.sourceConfigs).toEqual([
      { source: "netease", enabled: true, visible: true },
    ]);
    expect(JSON.stringify(persisted)).not.toContain("unknownProviderField");
    expect(JSON.stringify(persisted)).not.toContain("four-pass-canary");
  });
});
