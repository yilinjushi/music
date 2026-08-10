import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sanitizeMediaSessionArtworkUrl,
  useMediaSessionIntegration,
} from "./useMediaSessionIntegration";
import { useMusicStore } from "@/store/music-store";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

const actionHandlers = new Map<
  MediaSessionAction,
  MediaSessionActionHandler | null
>();

const mediaSession = {
  metadata: null as MediaMetadata | null,
  playbackState: "none" as MediaSessionPlaybackState,
  setActionHandler: vi.fn(
    (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      actionHandlers.set(action, handler);
    }
  ),
  setPositionState: vi.fn(),
} as unknown as MediaSession;

class MockMediaMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: MediaImage[];

  constructor(init: MediaMetadataInit = {}) {
    this.title = init.title ?? "";
    this.artist = init.artist ?? "";
    this.album = init.album ?? "";
    this.artwork = init.artwork ?? [];
  }
}

describe("useMediaSessionIntegration", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    actionHandlers.clear();
    mediaSession.metadata = null;
    mediaSession.playbackState = "none";

    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: mediaSession,
    });
    Object.defineProperty(globalThis, "MediaMetadata", {
      configurable: true,
      value: MockMediaMetadata,
    });

    useMusicStore.setState({
      queue: [],
      currentIndex: 0,
      isPlaying: false,
      hasUserGesture: false,
    });
  });

  const renderHook = async (coverUrl: string | null | undefined) => {
    const audio = document.createElement("audio");
    Object.defineProperties(audio, {
      duration: { configurable: true, value: 120 },
      currentTime: { configurable: true, writable: true, value: 30 },
    });
    const audioRef = { current: audio } as React.RefObject<HTMLAudioElement>;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function TestHarness() {
      useMediaSessionIntegration(audioRef, coverUrl);
      return null;
    }

    await act(async () => {
      root.render(<TestHarness />);
    });

    return {
      audio,
      cleanup: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  };

  it("sanitizes http artwork URL to https", () => {
    expect(sanitizeMediaSessionArtworkUrl("http://image.test/cover.jpg")).toBe(
      "https://image.test/cover.jpg"
    );
  });

  it("drops unsafe artwork URL", () => {
    expect(sanitizeMediaSessionArtworkUrl("javascript:alert(1)")).toBeNull();
    expect(
      sanitizeMediaSessionArtworkUrl("http://localhost:3000/cover.jpg")
    ).toBeNull();
  });

  it("sets standard browser metadata with sanitized artwork", async () => {
    useMusicStore.setState({
      queue: [
        {
          id: "1",
          name: "Song",
          artist: ["Artist"],
          album: "Album",
          pic_id: "pic-1",
          url_id: "url-1",
          lyric_id: "lyric-1",
          source: "joox",
        },
      ],
      currentIndex: 0,
    });

    const { cleanup } = await renderHook("http://image.test/cover.jpg");

    expect(mediaSession.metadata).toMatchObject({
      title: "Song",
      artist: "Artist",
      album: "Album",
      artwork: [{ src: "https://image.test/cover.jpg" }],
    });
    cleanup();
  });

  it("registers seek handlers and clamps seek-to to the track duration", async () => {
    const { cleanup } = await renderHook(null);

    const seekTo = actionHandlers.get("seekto");
    expect(seekTo).toBeTypeOf("function");
    act(() => seekTo?.({ action: "seekto", seekTime: 999 }));

    expect(useMusicStore.getState().seekTargetTime).toBe(120);
    cleanup();
  });

  it("records cold-start play intent before a restored track has a source", async () => {
    useMusicStore.setState({
      queue: [
        {
          id: "restored-1",
          name: "Restored Song",
          artist: ["Artist"],
          album: "Album",
          pic_id: "pic-1",
          url_id: "url-1",
          lyric_id: "lyric-1",
          source: "netease",
        },
      ],
      currentIndex: 0,
      isPlaying: false,
      hasUserGesture: false,
    });
    const { audio, cleanup } = await renderHook(null);
    const play = vi.spyOn(audio, "play").mockResolvedValue();

    const playAction = actionHandlers.get("play");
    act(() => playAction?.({ action: "play" }));

    expect(useMusicStore.getState().hasUserGesture).toBe(true);
    expect(useMusicStore.getState().isPlaying).toBe(true);
    expect(play).not.toHaveBeenCalled();
    cleanup();
  });

  it("removes browser action handlers when the player unmounts", async () => {
    const { cleanup } = await renderHook(null);
    cleanup();

    expect(mediaSession.setActionHandler).toHaveBeenCalledWith("play", null);
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith(
      "nexttrack",
      null
    );
  });
});
