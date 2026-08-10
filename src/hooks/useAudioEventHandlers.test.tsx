import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useAudioEventHandlers } from "./useAudioEventHandlers";
import { useMusicStore } from "@/store/music-store";
import { handleAutoMatch } from "@/lib/audio-match";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("react-hot-toast", () => ({
  default: {
    dismiss: vi.fn(),
  },
}));

vi.mock("@/lib/audio-match", () => ({
  handleAutoMatch: vi.fn(),
}));

describe("useAudioEventHandlers pause confirm", () => {
  beforeEach(() => {
    // Silence React act warnings for root render/unmount in test env.
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.clearAllMocks();

    useMusicStore.setState({
      queue: [],
      currentIndex: 0,
      playbackContextEpoch: 0,
      isPlaying: true,
      isLoading: false,
      isRepeat: false,
      enableAutoMatch: true,
      urlRecoveryKey: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const audio = document.createElement("audio");

    let paused = false;
    Object.defineProperty(audio, "paused", {
      configurable: true,
      get: () => paused,
    });

    const audioRef = {
      current: audio,
    } as React.RefObject<HTMLAudioElement | null>;
    const isSwitchingTrackRef = { current: false };
    const hasRecordedRef = { current: true };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function TestHarness() {
      useAudioEventHandlers(audioRef, isSwitchingTrackRef, hasRecordedRef);
      return null;
    }

    act(() => {
      root.render(<TestHarness />);
    });

    const cleanup = () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    return {
      audio,
      setPaused: (value: boolean) => {
        paused = value;
      },
      isSwitchingTrackRef,
      cleanup,
    };
  };

  it("does not set isPlaying=false if play resumes within 200ms", () => {
    const { audio, setPaused, cleanup } = setup();

    setPaused(true);
    audio.dispatchEvent(new Event("pause"));

    vi.advanceTimersByTime(100);

    setPaused(false);
    audio.dispatchEvent(new Event("play"));

    vi.advanceTimersByTime(250);

    expect(useMusicStore.getState().isPlaying).toBe(true);
    cleanup();
  });

  it("sets isPlaying=false if pause stays stable for 200ms", () => {
    const { audio, setPaused, cleanup } = setup();

    setPaused(true);
    audio.dispatchEvent(new Event("pause"));

    vi.advanceTimersByTime(250);

    expect(useMusicStore.getState().isPlaying).toBe(false);
    cleanup();
  });

  it("does not set isPlaying=false while switching track", () => {
    const { audio, setPaused, isSwitchingTrackRef, cleanup } = setup();

    isSwitchingTrackRef.current = true;
    setPaused(true);
    audio.dispatchEvent(new Event("pause"));

    vi.advanceTimersByTime(250);

    expect(useMusicStore.getState().isPlaying).toBe(true);
    cleanup();
  });

  it("leaves load-time errors to the active track loader", () => {
    const { audio, isSwitchingTrackRef, cleanup } = setup();
    useMusicStore.setState({
      queue: [
        {
          id: "stable",
          name: "Stable track",
          artist: ["Artist"],
          album: "Album",
          source: "joox",
          pic_id: "pic",
          url_id: "url",
          lyric_id: "lyric",
        },
      ],
      currentIndex: 0,
    });

    isSwitchingTrackRef.current = true;
    audio.dispatchEvent(new Event("error"));

    expect(useMusicStore.getState().urlRecoveryKey).toBe(0);

    isSwitchingTrackRef.current = false;
    audio.dispatchEvent(new Event("error"));

    expect(useMusicStore.getState().urlRecoveryKey).toBe(1);
    cleanup();
  });

  it("ignores delayed native errors after a terminal loader failure", () => {
    const { audio, cleanup } = setup();
    useMusicStore.setState({
      queue: [
        {
          id: "failed",
          name: "Failed track",
          artist: ["Artist"],
          album: "Album",
          source: "joox",
          pic_id: "pic",
          url_id: "url",
          lyric_id: "lyric",
        },
      ],
      currentIndex: 0,
    });
    audio.dataset.terminalLoadFailure = "request-2";

    audio.dispatchEvent(new Event("error"));

    expect(useMusicStore.getState().urlRecoveryKey).toBe(0);
    expect(useMusicStore.getState().isPlaying).toBe(true);
    cleanup();
  });

  it("serializes durationchange auto-match and aborts a stale owner", async () => {
    const { audio, cleanup } = setup();
    const trackA = {
      id: "sample-a",
      name: "Sample A",
      artist: ["Artist"],
      album: "Album",
      source: "_netease" as const,
      pic_id: "pic-a",
      url_id: "url-a",
      lyric_id: "lyric-a",
    };
    const trackB = {
      ...trackA,
      id: "sample-b",
      name: "Sample B",
      url_id: "url-b",
    };
    Object.defineProperty(audio, "duration", {
      configurable: true,
      value: 30,
    });
    vi.mocked(handleAutoMatch).mockReturnValue(new Promise(() => {}));
    useMusicStore.setState({ queue: [trackA], currentIndex: 0 });

    await act(async () => {
      audio.dispatchEvent(new Event("durationchange"));
      audio.dispatchEvent(new Event("durationchange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(handleAutoMatch).toHaveBeenCalledOnce();
    const firstSignal = vi.mocked(handleAutoMatch).mock.calls[0]?.[3];
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(firstSignal?.aborted).toBe(false);

    useMusicStore.setState({ queue: [trackB] });
    await act(async () => {
      audio.dispatchEvent(new Event("durationchange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(firstSignal?.aborted).toBe(true);
    expect(handleAutoMatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(handleAutoMatch).mock.calls[1]?.[0]).toEqual(trackB);
    cleanup();
  });

  it("does not reuse a durationchange owner after A -> B -> A", async () => {
    const { audio, cleanup } = setup();
    const trackA = {
      id: "sample-a",
      name: "Sample A",
      artist: ["Artist"],
      album: "Album",
      source: "_netease" as const,
      pic_id: "pic-a",
      url_id: "url-a",
      lyric_id: "lyric-a",
    };
    const trackB = {
      ...trackA,
      id: "sample-b",
      name: "Sample B",
      url_id: "url-b",
    };
    Object.defineProperty(audio, "duration", {
      configurable: true,
      value: 30,
    });
    vi.mocked(handleAutoMatch).mockReturnValue(new Promise(() => {}));
    useMusicStore.setState({
      queue: [trackA, trackB],
      currentIndex: 0,
      playbackContextEpoch: 0,
    });

    await act(async () => {
      audio.dispatchEvent(new Event("durationchange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstSignal = vi.mocked(handleAutoMatch).mock.calls[0]?.[3];
    expect(firstSignal?.aborted).toBe(false);

    useMusicStore.getState().setCurrentIndexAndPlay(1);
    useMusicStore.getState().setCurrentIndexAndPlay(0);
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      audio.dispatchEvent(new Event("durationchange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(handleAutoMatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(handleAutoMatch).mock.calls[1]?.[0]).toEqual(trackA);
    cleanup();
  });
});
