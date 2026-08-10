import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  sanitizePersistedHistoryState,
  useHistoryStore,
} from "./history-store";
import type { MusicTrack } from "@/types/music";

// Mock dependencies
vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
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

describe("HistoryStore", () => {
  beforeEach(() => {
    // Reset store state
    useHistoryStore.setState({
      history: [],
    });
    vi.clearAllMocks();
  });

  describe("addToHistory", () => {
    it("should add a track to history", () => {
      const track = createTrack("1", "Song 1");
      useHistoryStore.getState().addToHistory(track);

      const history = useHistoryStore.getState().history;
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe("1");
    });

    it("should move existing track to top", () => {
      const track1 = createTrack("1", "Song 1");
      const track2 = createTrack("2", "Song 2");

      useHistoryStore.getState().addToHistory(track1);
      useHistoryStore.getState().addToHistory(track2);
      useHistoryStore.getState().addToHistory(track1); // Re-add track1

      const history = useHistoryStore.getState().history;
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe("1"); // Track 1 is now first
      expect(history[1].id).toBe("2");
    });

    it("should limit history size to 100", () => {
      // Add 101 tracks
      for (let i = 0; i < 101; i++) {
        useHistoryStore
          .getState()
          .addToHistory(createTrack(`track-${i}`, `Song ${i}`));
      }

      const history = useHistoryStore.getState().history;
      expect(history).toHaveLength(100);
      expect(history[0].id).toBe("track-100"); // Latest
      expect(history[99].id).toBe("track-1"); // Oldest (track-0 was removed)
    });

    it("rejects sensitive tracks and removes them during hydration migration", () => {
      const unsafe = {
        ...createTrack("unsafe", "Unsafe"),
        arbitrary: "X-Amz-Signature=capability-canary",
      } as MusicTrack;

      useHistoryStore.getState().addToHistory(unsafe);
      expect(useHistoryStore.getState().history).toEqual([]);
      expect(
        sanitizePersistedHistoryState({
          history: [createTrack("safe", "Safe"), unsafe],
        }).history
      ).toEqual([expect.objectContaining({ id: "safe" })]);
    });
  });

  describe("removeFromHistory", () => {
    it("should remove track from history", () => {
      const track = createTrack("1", "Song 1");
      useHistoryStore.getState().addToHistory(track);
      useHistoryStore.getState().removeFromHistory(track);

      expect(useHistoryStore.getState().history).toHaveLength(0);
    });

    it("does not remove the same provider id from another source", () => {
      const netease = createTrack("1", "Netease");
      const official = {
        ...createTrack("1", "Official"),
        source: "_netease" as const,
      };
      useHistoryStore.getState().addToHistory(netease);
      useHistoryStore.getState().addToHistory(official);

      useHistoryStore.getState().removeFromHistory(netease);

      expect(useHistoryStore.getState().history).toEqual([
        expect.objectContaining({ source: "_netease", id: "1" }),
      ]);
    });

    it("does not remove a different source that reuses the same provider id", () => {
      const neteaseTrack = createTrack("shared", "NetEase");
      const kuwoTrack = {
        ...createTrack("shared", "Kuwo"),
        source: "kuwo" as const,
        url_id: "kuwo-recording",
      };
      useHistoryStore.getState().addToHistory(neteaseTrack);
      useHistoryStore.getState().addToHistory(kuwoTrack);

      useHistoryStore.getState().removeFromHistory(neteaseTrack);

      expect(useHistoryStore.getState().history).toEqual([kuwoTrack]);
    });

    it("removes only the selected occurrence of an exact duplicate", () => {
      const first = createTrack("same", "First");
      const second = { ...first, name: "Second" };
      useHistoryStore.setState({ history: [first, second] });

      useHistoryStore.getState().removeFromHistory(second);

      expect(useHistoryStore.getState().history).toEqual([first]);
    });
  });

  describe("clearHistory", () => {
    it("should clear all history", () => {
      useHistoryStore.getState().addToHistory(createTrack("1", "Song 1"));
      useHistoryStore.getState().addToHistory(createTrack("2", "Song 2"));
      useHistoryStore.getState().clearHistory();

      expect(useHistoryStore.getState().history).toHaveLength(0);
    });
  });
});
