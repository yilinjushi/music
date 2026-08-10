import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMusicStore } from "./music-store";
import type { MusicTrack } from "@/types/music";
import { toastUtils } from "@/lib/utils/toast";

// Mock dependencies
vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("@/lib/utils/toast", () => ({
  toastUtils: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Helper to create a dummy track
const createTrack = (id: string, title: string): MusicTrack => ({
  id,
  name: title,
  artist: ["Artist"],
  album: "Album",
  pic_id: id,
  url_id: id,
  lyric_id: id,
  source: "netease",
});

const createIdentityVariant = (
  id: string,
  source: MusicTrack["source"],
  urlId: string
): MusicTrack => ({
  ...createTrack(id, `${source}-${urlId}`),
  source,
  url_id: urlId,
});

describe("MusicStore", () => {
  beforeEach(() => {
    // Reset store state
    useMusicStore.setState({
      favorites: [],
      playlists: [],
      queue: [],
      originalQueue: [],
      currentIndex: 0,
      playbackContextEpoch: 0,
      isShuffle: false,
      isPlaying: false,
      currentAudioTime: 0,
      currentAudioUrl: null,
      fullScreenBackgroundMode: "theme",
    });
    vi.clearAllMocks();
  });

  describe("Settings", () => {
    it("should use theme color background by default", () => {
      expect(useMusicStore.getState().fullScreenBackgroundMode).toBe("theme");
    });

    it("should update full screen background mode", () => {
      useMusicStore.getState().setFullScreenBackgroundMode("cover");
      expect(useMusicStore.getState().fullScreenBackgroundMode).toBe("cover");

      useMusicStore.getState().setFullScreenBackgroundMode("texture");
      expect(useMusicStore.getState().fullScreenBackgroundMode).toBe("texture");
    });
  });

  describe("Favorites", () => {
    it("should add a track to favorites", () => {
      const track = createTrack("1", "Song 1");
      const result = useMusicStore.getState().addToFavorites(track);

      expect(result).toBeNull();
      expect(useMusicStore.getState().favorites).toHaveLength(1);
      expect(useMusicStore.getState().favorites[0].id).toBe("1");
    });

    it("should not add duplicate track to favorites", () => {
      const track = createTrack("1", "Song 1");
      useMusicStore.getState().addToFavorites(track);
      const result = useMusicStore.getState().addToFavorites(track);

      expect(result).toBe("已在「我的喜欢」中");
      expect(useMusicStore.getState().favorites).toHaveLength(1);
    });

    it("should handle local tracks (not supported)", () => {
      const track = {
        ...createTrack("local1", "Local Song"),
        source: "local" as const,
      };
      const result = useMusicStore.getState().addToFavorites(track);

      expect(result).toBe("本地音乐不支持喜欢");
      expect(useMusicStore.getState().favorites).toHaveLength(0);
    });

    it("should remove and restore favorites", () => {
      const track = createTrack("1", "Song 1");
      useMusicStore.getState().addToFavorites(track);

      useMusicStore.getState().removeFromFavorites(track);
      expect(useMusicStore.getState().favorites[0].is_deleted).toBe(true);
      expect(useMusicStore.getState().isFavorite(track)).toBe(false);

      useMusicStore.getState().restoreFromFavorites(track);
      expect(useMusicStore.getState().favorites[0].is_deleted).toBe(false);
      expect(useMusicStore.getState().isFavorite(track)).toBe(true);
    });

    it("keeps equal ids from different sources and url ids independent", () => {
      const netease = createIdentityVariant("1", "netease", "url-a");
      const official = createIdentityVariant("1", "_netease", "url-a");
      const alternate = createIdentityVariant("1", "netease", "url-b");

      useMusicStore
        .getState()
        .addBatchToFavorites([netease, official, alternate]);
      expect(useMusicStore.getState().favorites).toHaveLength(3);

      useMusicStore.getState().removeFromFavorites(netease);
      expect(useMusicStore.getState().isFavorite(netease)).toBe(false);
      expect(useMusicStore.getState().isFavorite(official)).toBe(true);
      expect(useMusicStore.getState().isFavorite(alternate)).toBe(true);

      useMusicStore.getState().removeBatchFromFavorites([official]);
      expect(useMusicStore.getState().isFavorite(official)).toBe(false);
      expect(useMusicStore.getState().isFavorite(alternate)).toBe(true);
    });

    it("soft-deletes only the selected occurrence of an exact duplicate", () => {
      const first = createTrack("same", "First occurrence");
      const second = { ...first, name: "Second occurrence" };
      useMusicStore.setState({ favorites: [first, second] });

      useMusicStore.getState().removeFromFavorites(second);

      expect(useMusicStore.getState().favorites).toEqual([
        first,
        expect.objectContaining({
          name: "Second occurrence",
          is_deleted: true,
        }),
      ]);
    });

    it("keeps favorites with a shared id isolated by source and url identity", () => {
      const baseTrack = {
        ...createTrack("shared", "Base recording"),
        url_id: "base-recording",
      };
      const sourceVariant = {
        ...baseTrack,
        name: "Other source",
        source: "kuwo" as const,
      };
      const urlVariant = {
        ...baseTrack,
        name: "Other recording",
        url_id: "alternate-recording",
      };

      useMusicStore
        .getState()
        .addBatchToFavorites([baseTrack, sourceVariant, urlVariant]);
      useMusicStore.getState().removeFromFavorites(baseTrack);

      expect(useMusicStore.getState().isFavorite(baseTrack)).toBe(false);
      expect(useMusicStore.getState().isFavorite(sourceVariant)).toBe(true);
      expect(useMusicStore.getState().isFavorite(urlVariant)).toBe(true);
    });
  });

  describe("addBatchToFavorites", () => {
    it("should add multiple tracks in a single set call", () => {
      const tracks = [
        createTrack("1", "Song 1"),
        createTrack("2", "Song 2"),
        createTrack("3", "Song 3"),
      ];
      useMusicStore.getState().addBatchToFavorites(tracks);

      const favorites = useMusicStore.getState().favorites;
      expect(favorites).toHaveLength(3);
      expect(favorites.map((t) => t.id)).toEqual(
        expect.arrayContaining(["1", "2", "3"])
      );
    });

    it("should skip local tracks", () => {
      const tracks = [
        createTrack("1", "Song 1"),
        { ...createTrack("local1", "Local Song"), source: "local" as const },
      ];
      useMusicStore.getState().addBatchToFavorites(tracks);

      const favorites = useMusicStore.getState().favorites;
      expect(favorites).toHaveLength(1);
      expect(favorites[0].id).toBe("1");
    });

    it("should not add duplicates already in favorites", () => {
      useMusicStore.getState().addToFavorites(createTrack("1", "Song 1"));
      useMusicStore
        .getState()
        .addBatchToFavorites([
          createTrack("1", "Song 1"),
          createTrack("2", "Song 2"),
        ]);

      const favorites = useMusicStore.getState().favorites;
      const ids = favorites.filter((t) => !t.is_deleted).map((t) => t.id);
      expect(ids.filter((id) => id === "1")).toHaveLength(1);
      expect(ids).toContain("2");
    });

    it("should re-add tracks that were soft-deleted (restore semantics)", () => {
      useMusicStore.getState().addToFavorites(createTrack("1", "Song 1"));
      const track = createTrack("1", "Song 1");
      useMusicStore.getState().removeFromFavorites(track);
      expect(useMusicStore.getState().isFavorite(track)).toBe(false);

      useMusicStore
        .getState()
        .addBatchToFavorites([createTrack("1", "Song 1")]);
      expect(useMusicStore.getState().isFavorite(track)).toBe(true);
    });

    it("should do nothing if all tracks are local", () => {
      useMusicStore
        .getState()
        .addBatchToFavorites([
          { ...createTrack("l1", "L1"), source: "local" as const },
        ]);
      expect(useMusicStore.getState().favorites).toHaveLength(0);
    });

    it("should preserve deleted favorites when replacing active favorites", () => {
      useMusicStore.getState().addToFavorites(createTrack("1", "Song 1"));
      useMusicStore.getState().addToFavorites(createTrack("2", "Song 2"));
      useMusicStore.getState().removeFromFavorites(createTrack("1", "Song 1"));

      useMusicStore
        .getState()
        .replaceActiveFavorites([createTrack("2", "Song 2 updated")]);

      const favorites = useMusicStore.getState().favorites;
      expect(favorites).toHaveLength(2);
      expect(favorites[0]).toMatchObject({
        id: "2",
        name: "Song 2 updated",
        is_deleted: false,
      });
      expect(favorites[1]).toMatchObject({ id: "1", is_deleted: true });
    });
  });

  describe("addBatchToPlaylist", () => {
    it("should add multiple tracks to a playlist in one set call", () => {
      const pid = useMusicStore.getState().createPlaylist("Test");
      const tracks = [createTrack("1", "Song 1"), createTrack("2", "Song 2")];
      useMusicStore.getState().addBatchToPlaylist(pid, tracks);

      const playlist = useMusicStore
        .getState()
        .playlists.find((p) => p.id === pid);
      expect(playlist?.tracks).toHaveLength(2);
    });

    it("should skip local tracks", () => {
      const pid = useMusicStore.getState().createPlaylist("Test");
      useMusicStore
        .getState()
        .addBatchToPlaylist(pid, [
          createTrack("1", "Song 1"),
          { ...createTrack("l1", "Local"), source: "local" as const },
        ]);

      const playlist = useMusicStore
        .getState()
        .playlists.find((p) => p.id === pid);
      expect(playlist?.tracks).toHaveLength(1);
      expect(playlist?.tracks[0].id).toBe("1");
    });

    it("should not create duplicates in playlist", () => {
      const pid = useMusicStore.getState().createPlaylist("Test");
      useMusicStore.getState().addToPlaylist(pid, createTrack("1", "Song 1"));
      useMusicStore
        .getState()
        .addBatchToPlaylist(pid, [
          createTrack("1", "Song 1"),
          createTrack("2", "Song 2"),
        ]);

      const playlist = useMusicStore
        .getState()
        .playlists.find((p) => p.id === pid);
      const ids =
        playlist?.tracks.filter((t) => !t.is_deleted).map((t) => t.id) ?? [];
      expect(ids.filter((id) => id === "1")).toHaveLength(1);
      expect(ids).toContain("2");
    });

    it("does not merge or remove equal ids with different composite identities", () => {
      const pid = useMusicStore.getState().createPlaylist("Identity");
      const netease = createIdentityVariant("1", "netease", "url-a");
      const official = createIdentityVariant("1", "_netease", "url-a");
      const alternate = createIdentityVariant("1", "netease", "url-b");

      useMusicStore
        .getState()
        .addBatchToPlaylist(pid, [netease, official, alternate]);
      useMusicStore.getState().removeFromPlaylist(pid, official);

      const tracks = useMusicStore.getState().playlists[0].tracks;
      expect(tracks).toHaveLength(3);
      expect(
        tracks.find((track) => track.source === "_netease")?.is_deleted
      ).toBe(true);
      expect(
        tracks.find(
          (track) => track.url_id === "url-a" && track.source === "netease"
        )?.is_deleted
      ).toBe(false);
      expect(tracks.find((track) => track.url_id === "url-b")?.is_deleted).toBe(
        false
      );
    });

    it("removes only the selected exact playlist occurrence", () => {
      const first = createTrack("same", "First occurrence");
      const second = { ...first, name: "Second occurrence" };
      const pid = useMusicStore.getState().createPlaylist("Duplicates");
      useMusicStore.setState((state) => ({
        playlists: state.playlists.map((playlist) =>
          playlist.id === pid
            ? { ...playlist, tracks: [first, second] }
            : playlist
        ),
      }));

      useMusicStore.getState().removeBatchFromPlaylist(pid, [second]);

      expect(useMusicStore.getState().playlists[0].tracks).toEqual([
        first,
        expect.objectContaining({
          name: "Second occurrence",
          is_deleted: true,
        }),
      ]);
    });
  });

  describe("addBatchToNextPlay", () => {
    it("should insert all tracks after current in an empty queue", () => {
      const tracks = [createTrack("1", "Song 1"), createTrack("2", "Song 2")];
      useMusicStore.getState().addBatchToNextPlay(tracks);

      const state = useMusicStore.getState();
      expect(state.queue).toHaveLength(2);
      expect(state.queue[0].id).toBe("1");
    });

    it("should insert tracks after current index when queue exists", () => {
      const initialTracks = [createTrack("A", "A"), createTrack("B", "B")];
      useMusicStore.setState({
        queue: initialTracks,
        originalQueue: initialTracks,
        currentIndex: 0,
      });

      useMusicStore
        .getState()
        .addBatchToNextPlay([createTrack("X", "X"), createTrack("Y", "Y")]);

      const { queue } = useMusicStore.getState();
      expect(queue[0].id).toBe("A");
      expect(queue[1].id).toBe("X");
      expect(queue[2].id).toBe("Y");
      expect(queue[3].id).toBe("B");
    });

    it("should handle shuffle mode: also update originalQueue", () => {
      const initialTracks = [createTrack("A", "A"), createTrack("B", "B")];
      useMusicStore.setState({
        queue: initialTracks,
        originalQueue: initialTracks,
        currentIndex: 0,
        isShuffle: true,
      });

      useMusicStore.getState().addBatchToNextPlay([createTrack("X", "X")]);

      const { queue, originalQueue } = useMusicStore.getState();
      expect(queue[1].id).toBe("X");
      // originalQueue should also contain the new track
      expect(originalQueue.some((t) => t.id === "X")).toBe(true);
    });
  });

  describe("Playlists", () => {
    it("creates a fully validated imported playlist atomically", () => {
      const safe = createTrack("safe", "Safe song");
      const unsafe = {
        ...createTrack("unsafe", "Unsafe song"),
        pic_id: "https://cdn.example/cover.jpg?token=must-not-persist",
      };

      expect(() =>
        useMusicStore
          .getState()
          .createPlaylist("Mixed import", undefined, [safe, unsafe])
      ).toThrow("歌单包含不安全或格式无效的歌曲");
      expect(useMusicStore.getState().playlists).toEqual([]);

      const id = useMusicStore
        .getState()
        .createPlaylist("Safe import", undefined, [safe]);
      expect(useMusicStore.getState().playlists).toEqual([
        expect.objectContaining({
          id,
          name: "Safe import",
          tracks: [expect.objectContaining({ id: "safe" })],
        }),
      ]);
    });

    it("should create a playlist", () => {
      const id = useMusicStore.getState().createPlaylist("My Playlist");
      expect(id).toBeDefined();

      const playlists = useMusicStore.getState().playlists;
      expect(playlists).toHaveLength(1);
      expect(playlists[0].name).toBe("My Playlist");
      expect(playlists[0].id).toBe(id);
    });

    it("should delete and restore playlist", () => {
      const id = useMusicStore.getState().createPlaylist("My Playlist");

      useMusicStore.getState().deletePlaylist(id);
      expect(useMusicStore.getState().playlists[0].is_deleted).toBe(true);

      useMusicStore.getState().restorePlaylist(id);
      expect(useMusicStore.getState().playlists[0].is_deleted).toBe(false);
    });

    it("should add track to playlist", () => {
      const pid = useMusicStore.getState().createPlaylist("My Playlist");
      const track = createTrack("1", "Song 1");

      useMusicStore.getState().addToPlaylist(pid, track);

      const playlist = useMusicStore
        .getState()
        .playlists.find((p) => p.id === pid);
      expect(playlist?.tracks).toHaveLength(1);
      expect(playlist?.tracks[0].id).toBe("1");
    });

    it("should preserve deleted playlist tracks when replacing active tracks", () => {
      const pid = useMusicStore.getState().createPlaylist("My Playlist");
      useMusicStore.getState().addToPlaylist(pid, createTrack("1", "Song 1"));
      useMusicStore.getState().addToPlaylist(pid, createTrack("2", "Song 2"));
      useMusicStore
        .getState()
        .removeFromPlaylist(pid, createTrack("1", "Song 1"));

      useMusicStore
        .getState()
        .replaceActivePlaylistTracks(pid, [createTrack("2", "Song 2 updated")]);

      const playlist = useMusicStore
        .getState()
        .playlists.find((p) => p.id === pid);
      expect(playlist?.tracks).toHaveLength(2);
      expect(playlist?.tracks[0]).toMatchObject({
        id: "2",
        name: "Song 2 updated",
        is_deleted: false,
      });
      expect(playlist?.tracks[1]).toMatchObject({ id: "1", is_deleted: true });
    });
  });

  describe("Queue Management", () => {
    const tracks = [
      createTrack("1", "Song 1"),
      createTrack("2", "Song 2"),
      createTrack("3", "Song 3"),
    ];

    it("keeps the current audio URL state behind the playback URL validator", () => {
      expect(() =>
        useMusicStore
          .getState()
          .setCurrentAudioUrl("https://media.example/a.mp3?vkey=private-canary")
      ).toThrow("SENSITIVE_AUDIO_URL");
      expect(useMusicStore.getState().currentAudioUrl).toBeNull();

      const opaque = "/music-api/bilibili/audio?bvid=BV1xx411c7mD&cid=2164311";
      useMusicStore.getState().setCurrentAudioUrl(opaque);
      expect(useMusicStore.getState().currentAudioUrl).toBe(opaque);
    });

    it("playContext should set queue correctly in normal mode", () => {
      useMusicStore.getState().playContext(tracks, 1); // Play starting from index 1 (Song 2)

      const state = useMusicStore.getState();
      expect(state.queue).toHaveLength(3);
      expect(state.currentIndex).toBe(1);
      expect(state.queue[1].id).toBe("2");
      expect(state.isShuffle).toBe(false);
      expect(state.isPlaying).toBe(true);
    });

    it("filters unrelated invalid entries while preserving the selected safe track", () => {
      const unsafe = {
        ...tracks[0],
        pic_id: "https://cdn.example/cover.jpg?token=unsafe",
      };
      useMusicStore.getState().playContext([unsafe, tracks[1], tracks[2]], 2);

      const state = useMusicStore.getState();
      expect(state.queue.map((track) => track.id)).toEqual(["2", "3"]);
      expect(state.currentIndex).toBe(1);
      expect(state.queue[state.currentIndex].id).toBe("3");
    });

    it("explicitly rejects an invalid selected track without replacing the queue", () => {
      const existing = [tracks[2]];
      const unsafe = {
        ...tracks[0],
        pic_id: "https://cdn.example/cover.jpg?token=unsafe",
      };
      useMusicStore.setState({ queue: existing, originalQueue: existing });

      useMusicStore.getState().playContext([unsafe, tracks[1]], 0);

      expect(useMusicStore.getState().queue).toEqual(existing);
      expect(toastUtils.error).toHaveBeenCalledWith(
        "所选歌曲包含不安全或无效的数据"
      );
    });

    it("playContext should set queue correctly in shuffle mode", () => {
      useMusicStore.setState({ isShuffle: true });
      useMusicStore.getState().playContext(tracks, 1); // Play Song 2

      const state = useMusicStore.getState();
      expect(state.queue).toHaveLength(3);
      expect(state.queue[0].id).toBe("2"); // Current played song is always first in shuffled queue (impl detail) or handled by currentIndex=0
      expect(state.currentIndex).toBe(0);
      expect(state.originalQueue).toHaveLength(3);
      expect(state.isPlaying).toBe(true);
    });

    it("toggleShuffle should shuffle queue but keep current track playing", () => {
      // Setup: [1, 2, 3], playing 2 (index 1)
      useMusicStore.setState({
        queue: tracks,
        originalQueue: tracks,
        currentIndex: 1,
        isShuffle: false,
      });

      useMusicStore.getState().toggleShuffle();

      const state = useMusicStore.getState();
      expect(state.isShuffle).toBe(true);
      expect(state.queue[0].id).toBe("2"); // Current track moved to top
      expect(state.currentIndex).toBe(0);
      expect(state.queue).toHaveLength(3);
      // Original queue should be preserved
      expect(state.originalQueue).toEqual(tracks);
    });

    it("toggleShuffle off should restore original queue order", () => {
      // Setup: Shuffle mode, queue might be [2, 1, 3] (shuffled), playing 2
      useMusicStore.setState({
        isShuffle: true,
        queue: [tracks[1], tracks[0], tracks[2]],
        originalQueue: tracks,
        currentIndex: 0, // Playing tracks[1] (Song 2)
      });

      useMusicStore.getState().toggleShuffle();

      const state = useMusicStore.getState();
      expect(state.isShuffle).toBe(false);
      expect(state.queue).toEqual(tracks); // Back to original order
      expect(state.currentIndex).toBe(1); // Still pointing to Song 2
    });

    it("addToNextPlay should insert track after current index", () => {
      // Setup: [1, 2], playing 1 (index 0)
      const initialQueue = [tracks[0], tracks[1]];
      useMusicStore.setState({
        queue: initialQueue,
        originalQueue: initialQueue,
        currentIndex: 0,
      });

      const newTrack = createTrack("3", "Song 3");
      useMusicStore.getState().addToNextPlay(newTrack);

      const state = useMusicStore.getState();
      expect(state.queue).toHaveLength(3);
      expect(state.queue[1].id).toBe("3"); // Inserted at index 1
      expect(state.queue[2].id).toBe("2"); // Previous next song pushed down
    });

    it("should remove track from queue and adjust index", () => {
      // Setup: [1, 2, 3], playing 2 (index 1)
      useMusicStore.setState({
        queue: tracks,
        originalQueue: tracks,
        currentIndex: 1,
        isPlaying: true,
      });

      // Remove current song (Song 2)
      useMusicStore.getState().removeFromQueue(tracks[1]);

      const state = useMusicStore.getState();
      expect(state.queue).toHaveLength(2);
      expect(state.queue[0].id).toBe("1");
      expect(state.queue[1].id).toBe("3");
      // Should point to next song (Song 3 which is now at index 1) or stay at index 1?
      // Logic: if removing current, index stays same (pointing to next) unless it was last
      // Here: removed index 1. Array shifts. Old index 2 becomes 1. So index 1 is now Song 3.
      expect(state.currentIndex).toBe(1);
      expect(state.queue[state.currentIndex].id).toBe("3");

      // Remove previous song (Song 1)
      useMusicStore.getState().removeFromQueue(tracks[0]);
      const state2 = useMusicStore.getState();
      expect(state2.queue).toHaveLength(1);
      // Index should decrease
      expect(state2.currentIndex).toBe(0);
      expect(state2.queue[0].id).toBe("3");
    });

    it("removes only one composite queue identity when provider ids collide", () => {
      const netease = createIdentityVariant("1", "netease", "url-a");
      const official = createIdentityVariant("1", "_netease", "url-a");
      const alternate = createIdentityVariant("1", "netease", "url-b");
      useMusicStore.setState({
        queue: [netease, official, alternate],
        originalQueue: [netease, official, alternate],
        currentIndex: 1,
        isShuffle: true,
      });

      useMusicStore.getState().removeFromQueue(official);

      expect(useMusicStore.getState().queue).toEqual([netease, alternate]);
      expect(useMusicStore.getState().originalQueue).toEqual([
        netease,
        alternate,
      ]);
    });

    it("selects the requested composite identity in an existing shuffle context", () => {
      const netease = createIdentityVariant("1", "netease", "url-a");
      const official = createIdentityVariant("1", "_netease", "url-a");
      useMusicStore.setState({
        queue: [official, netease],
        originalQueue: [netease, official],
        currentIndex: 0,
        contextId: "same-context",
        isShuffle: true,
      });

      useMusicStore
        .getState()
        .playContext([netease, official], 0, "same-context");

      expect(useMusicStore.getState().currentIndex).toBe(1);
      expect(useMusicStore.getState().queue[1]).toMatchObject({
        source: "netease",
        url_id: "url-a",
      });
    });

    it("CAS replaces only the indexed full-identity owner across every location", () => {
      const wrongSource = {
        ...createTrack("same", "Wrong source"),
        source: "kuwo" as const,
        url_id: "wrong-url",
      };
      const owner = {
        ...createTrack("same", "Owner"),
        source: "netease" as const,
        url_id: "owner-url",
      };
      const duplicateOwner = { ...owner };
      const replacement = {
        ...createTrack("replacement", "Replacement"),
        source: "joox" as const,
        url_id: "replacement-url",
      };
      const collisions = [wrongSource, owner, duplicateOwner];
      useMusicStore.setState({
        queue: collisions,
        originalQueue: collisions,
        currentIndex: 1,
        currentAudioUrl: "https://media.example/old.mp3",
        favorites: collisions,
        playlists: [
          {
            id: "p1",
            name: "Collisions",
            createdAt: 0,
            tracks: collisions,
          },
        ],
      });

      const committed = useMusicStore.getState().compareAndSwapMatchedTrack(
        {
          contextEpoch: useMusicStore.getState().playbackContextEpoch,
          queue: {
            index: 1,
            id: owner.id,
            source: owner.source,
            urlId: owner.url_id,
          },
          originalQueue: {
            index: 1,
            id: owner.id,
            source: owner.source,
            urlId: owner.url_id,
          },
          favorite: {
            index: 1,
            id: owner.id,
            source: owner.source,
            urlId: owner.url_id,
          },
          playlist: {
            playlistId: "p1",
            playlistIndex: 0,
            trackIndex: 1,
            id: owner.id,
            source: owner.source,
            urlId: owner.url_id,
          },
        },
        replacement
      );

      expect(committed).toBe(true);
      const state = useMusicStore.getState();
      for (const location of [
        state.queue,
        state.originalQueue,
        state.favorites,
        state.playlists[0].tracks,
      ]) {
        expect(location.map((item) => `${item.source}:${item.url_id}`)).toEqual(
          ["kuwo:wrong-url", "joox:replacement-url", "netease:owner-url"]
        );
      }
      expect(state.currentAudioUrl).toBeNull();
    });

    it("CAS rejects an A -> B -> A owner from an older playback incarnation", () => {
      const trackA = createTrack("A", "Song A");
      const trackB = createTrack("B", "Song B");
      const replacement = createTrack("replacement", "Replacement");
      useMusicStore.setState({
        queue: [trackA, trackB],
        originalQueue: [trackA, trackB],
        currentIndex: 0,
        playbackContextEpoch: 0,
      });
      const staleEpoch = useMusicStore.getState().playbackContextEpoch;

      useMusicStore.getState().setCurrentIndexAndPlay(1);
      useMusicStore.getState().setCurrentIndexAndPlay(0);

      const committed = useMusicStore.getState().compareAndSwapMatchedTrack(
        {
          contextEpoch: staleEpoch,
          queue: {
            index: 0,
            id: trackA.id,
            source: trackA.source,
            urlId: trackA.url_id,
          },
        },
        replacement
      );

      expect(committed).toBe(false);
      expect(useMusicStore.getState().queue).toEqual([trackA, trackB]);
      expect(useMusicStore.getState().playbackContextEpoch).toBeGreaterThan(
        staleEpoch
      );
    });

    it("does not disturb active playback for a collection-only match owner", () => {
      const playing = createTrack("playing", "Playing");
      const stored = createTrack("stored", "Stored");
      const replacement = createIdentityVariant(
        "replacement",
        "kuwo",
        "replacement-url"
      );
      useMusicStore.setState({
        queue: [playing],
        originalQueue: [playing],
        currentIndex: 0,
        currentAudioUrl: "https://media.example/playing.mp3",
        playbackContextEpoch: 17,
        favorites: [stored],
        playlists: [
          { id: "p1", name: "Stored", createdAt: 0, tracks: [stored] },
        ],
      });

      const committed = useMusicStore.getState().compareAndSwapMatchedTrack(
        {
          contextEpoch: 17,
          favorite: {
            index: 0,
            id: stored.id,
            source: stored.source,
            urlId: stored.url_id,
          },
          playlist: {
            playlistId: "p1",
            playlistIndex: 0,
            trackIndex: 0,
            id: stored.id,
            source: stored.source,
            urlId: stored.url_id,
          },
        },
        replacement
      );

      const state = useMusicStore.getState();
      expect(committed).toBe(true);
      expect(state.playbackContextEpoch).toBe(17);
      expect(state.currentAudioUrl).toBe("https://media.example/playing.mp3");
      expect(state.queue).toEqual([playing]);
      expect(state.favorites[0]).toMatchObject({ id: "replacement" });
      expect(state.playlists[0].tracks[0]).toMatchObject({ id: "replacement" });
    });
  });
});
