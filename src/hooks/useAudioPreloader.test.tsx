import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "@/types/music";
import { useMusicStore } from "@/store/music-store";
import { useAudioPreloader } from "./useAudioPreloader";

const resolver = vi.hoisted(() => ({
  resolveTrackUrl: vi.fn(),
}));

vi.mock("@/lib/audio-resolver", () => resolver);

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const makeTrack = (id: string): MusicTrack => ({
  id,
  name: `Track ${id}`,
  artist: ["Artist"],
  album: "Album",
  source: "joox",
  pic_id: `pic-${id}`,
  url_id: `url-${id}`,
  lyric_id: `lyric-${id}`,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useAudioPreloader", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn());
    useMusicStore.setState({
      queue: [makeTrack("current"), makeTrack("next")],
      currentIndex: 0,
      quality: "192",
      isPlaying: true,
      isRepeat: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const setup = () => {
    const audio = document.createElement("audio");
    Object.defineProperty(audio, "duration", {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(audio, "currentTime", {
      configurable: true,
      value: 175,
    });
    const audioRef = {
      current: audio,
    } as React.RefObject<HTMLAudioElement | null>;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      useAudioPreloader(audioRef);
      return null;
    }

    act(() => root.render(<Harness />));
    return {
      audio,
      cleanup: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  };

  it("passes cancellation ownership and never downloads an opaque full track", async () => {
    resolver.resolveTrackUrl.mockResolvedValue({
      url: "https://audio.test/next.mp3",
    });
    const { audio, cleanup } = setup();

    audio.dispatchEvent(new Event("timeupdate"));

    await vi.waitFor(() => {
      expect(resolver.resolveTrackUrl).toHaveBeenCalledWith(
        expect.objectContaining({ id: "next" }),
        192,
        expect.any(AbortSignal)
      );
    });
    expect(fetch).not.toHaveBeenCalled();
    cleanup();
  });

  it("aborts and discards a deferred preload after the queue owner changes", async () => {
    const pending = deferred<{ url: string }>();
    resolver.resolveTrackUrl.mockReturnValue(pending.promise);
    const { audio, cleanup } = setup();

    audio.dispatchEvent(new Event("timeupdate"));
    await vi.waitFor(() => expect(resolver.resolveTrackUrl).toHaveBeenCalled());
    const signal = resolver.resolveTrackUrl.mock.calls[0]?.[2] as AbortSignal;

    act(() => {
      useMusicStore.setState({ currentIndex: 1 });
    });
    expect(signal.aborted).toBe(true);

    pending.resolve({ url: "https://audio.test/stale-next.mp3" });
    await pending.promise;
    await Promise.resolve();

    expect(fetch).not.toHaveBeenCalled();
    cleanup();
  });
});
