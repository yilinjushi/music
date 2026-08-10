import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  importStoreData,
  serializeStoreData,
  validateBackupData,
} from "./data-backup";
import { useMusicStore } from "@/store/music-store";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("@/lib/utils/toast", () => ({
  toastUtils: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

const safeTrack = {
  id: "1",
  name: "Song",
  artist: ["Artist"],
  album: "Album",
  pic_id: "cover",
  url_id: "https://media.example/song.mp3",
  lyric_id: "lyric",
  source: "url" as const,
};

const envelope = (track: unknown) =>
  JSON.stringify({
    version: 1,
    type: "otter-music-backup",
    exportedAt: 1,
    data: {
      favorites: [track],
      playlists: [],
    },
  });

describe("data-backup sensitive ingress", () => {
  beforeEach(() => {
    useMusicStore.setState({ favorites: [], playlists: [] });
  });

  it.each([
    "Authorization: Bearer canary",
    "Cookie%3DMUSIC_U-canary",
    "MUSIC_U%25253Dtriple-canary",
    "X-Amz-Signature=capability-canary",
  ])("rejects plain and encoded canaries before import: %s", (canary) => {
    const result = validateBackupData(
      envelope({ ...safeTrack, arbitrary: { nested: canary } })
    );
    expect(result).toEqual(
      expect.objectContaining({
        valid: false,
        error: expect.stringMatching(/敏感/),
      })
    );
  });

  it("validates a safe backup and rejects a bypass of the validation UI", () => {
    expect(validateBackupData(envelope(safeTrack)).valid).toBe(true);

    expect(() =>
      importStoreData({
        favorites: [
          {
            ...safeTrack,
            arbitrary: "x-real-cookie=canary",
          } as typeof safeTrack,
        ],
        playlists: [],
      } as never)
    ).toThrow(/敏感/);
    expect(useMusicStore.getState().favorites).toEqual([]);
  });

  it("commits a validated restore atomically without leaving old playlists", () => {
    useMusicStore.setState({
      favorites: [],
      playlists: [
        {
          id: "old-playlist",
          name: "Old",
          createdAt: 1,
          tracks: [],
        },
      ],
    });

    importStoreData({
      favorites: [safeTrack],
      playlists: [
        {
          id: "restored-playlist",
          name: "Restored",
          createdAt: 2,
          tracks: [safeTrack],
        },
      ],
    } as never);

    const state = useMusicStore.getState();
    expect(state.favorites).toEqual([
      expect.objectContaining({ id: "1", is_deleted: false }),
    ]);
    expect(state.playlists).toEqual([
      expect.objectContaining({
        id: "restored-playlist",
        tracks: [expect.objectContaining({ id: "1", is_deleted: false })],
      }),
    ]);
    expect(state.playlists).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "old-playlist" })])
    );
  });

  it("returns an explicit backup field whitelist", () => {
    const raw = JSON.stringify({
      version: 1,
      type: "otter-music-backup",
      exportedAt: 1,
      data: {
        favorites: [safeTrack],
        playlists: [],
        volume: 0.5,
        unknownProviderField: "must-not-survive-validation",
        sourceConfigs: [
          {
            source: "netease",
            enabled: true,
            visible: true,
            unknownNestedField: "must-not-survive-validation",
          },
        ],
      },
    });

    const result = validateBackupData(raw);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.data).not.toHaveProperty("unknownProviderField");
    expect(result.data.sourceConfigs).toEqual([
      { source: "netease", enabled: true, visible: true },
    ]);
    expect(JSON.stringify(result.data)).not.toContain("unknownNestedField");
  });

  it("round-trips a valid application backup larger than 128 KiB", () => {
    useMusicStore.setState({
      favorites: Array.from({ length: 600 }, (_, index) => ({
        ...safeTrack,
        id: `large-${index}`,
        url_id: `https://media.example/large-${index}.mp3`,
        name: `Song ${index} ${"melody ".repeat(28)}`,
      })),
      playlists: [],
    });

    const raw = serializeStoreData();
    expect(new Blob([raw]).size).toBeGreaterThan(128 * 1024);
    const result = validateBackupData(raw);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.summary.favoritesCount).toBe(600);
    }
  });
});
