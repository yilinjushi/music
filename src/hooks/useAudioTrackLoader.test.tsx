import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "@/types/music";
import { useMusicStore } from "@/store/music-store";
import {
  buildUrlCacheKey,
  useUrlCacheStore,
} from "@/store/url-cache-store";
import { useAudioEventHandlers } from "./useAudioEventHandlers";
import { useAudioTrackLoader } from "./useAudioTrackLoader";

const resolver = vi.hoisted(() => ({
  resolveTrackUrl: vi.fn(),
  invalidateTrackUrlCache: vi.fn(),
}));
const api = vi.hoisted(() => ({
  getProxyUrl: vi.fn(
    (url: string) => `https://proxy.test/proxy?url=${encodeURIComponent(url)}`
  ),
  isProxyUrl: vi.fn((url: string) =>
    url.startsWith("https://proxy.test/proxy")
  ),
}));
const audioMatch = vi.hoisted(() => ({
  handleAutoMatch: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/audio-resolver", () => resolver);

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => api);

vi.mock("@/lib/audio-match", () => audioMatch);

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), {
    dismiss: vi.fn(),
    error: vi.fn(),
  }),
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

describe("useAudioTrackLoader request ownership and recovery", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    audioMatch.handleAutoMatch.mockResolvedValue(false);
    vi.stubGlobal("navigator", { onLine: true });
    useMusicStore.setState({
      queue: [],
      currentIndex: 0,
      playbackContextEpoch: 0,
      currentAudioTime: 0,
      currentAudioUrl: null,
      consecutiveFailures: 0,
      maxConsecutiveFailures: 3,
      isPlaying: true,
      isLoading: false,
      hasUserGesture: true,
      enableAutoMatch: false,
      enableProxyFallback: false,
      quality: "192",
      playbackSpeed: 1,
      urlRecoveryKey: 0,
    });
    useUrlCacheStore.setState({ urlMap: {}, generation: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup(onLoad: (audio: HTMLAudioElement) => void) {
    const audio = document.createElement("audio");
    let paused = true;

    Object.defineProperty(audio, "paused", {
      configurable: true,
      get: () => paused,
    });
    Object.defineProperty(audio, "pause", {
      configurable: true,
      value: vi.fn(() => {
        paused = true;
      }),
    });
    Object.defineProperty(audio, "load", {
      configurable: true,
      value: vi.fn(() => onLoad(audio)),
    });
    Object.defineProperty(audio, "play", {
      configurable: true,
      value: vi.fn(async () => {
        paused = false;
      }),
    });

    const audioRef = {
      current: audio,
    } as React.RefObject<HTMLAudioElement | null>;
    const isSwitchingTrackRef = { current: false };
    const hasRecordedRef = { current: false };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function TestHarness() {
      useAudioTrackLoader(audioRef, isSwitchingTrackRef, hasRecordedRef);
      useAudioEventHandlers(audioRef, isSwitchingTrackRef, hasRecordedRef);
      return null;
    }

    act(() => {
      root.render(<TestHarness />);
    });

    return {
      audio,
      cleanup: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  it("never lets a late A request replace B after B has started playing", async () => {
    const trackA = makeTrack("A");
    const trackB = makeTrack("B");
    const pendingA = deferred<{ url: string }>();
    resolver.resolveTrackUrl.mockImplementation((track: MusicTrack) =>
      track.id === "A"
        ? pendingA.promise
        : Promise.resolve({ url: "https://audio.test/B.mp3" })
    );

    useMusicStore.setState({ queue: [trackA, trackB], currentIndex: 0 });
    const { audio, cleanup } = setup((element) => {
      queueMicrotask(() => element.dispatchEvent(new Event("canplay")));
    });

    await vi.waitFor(() => {
      expect(resolver.resolveTrackUrl).toHaveBeenCalledWith(
        trackA,
        192,
        expect.any(AbortSignal)
      );
    });

    await act(async () => {
      useMusicStore.setState({ currentIndex: 1 });
    });
    await vi.waitFor(() => {
      expect(useMusicStore.getState().currentAudioUrl).toBe(
        "https://audio.test/B.mp3"
      );
      expect(audio.play).toHaveBeenCalledOnce();
    });

    pendingA.resolve({ url: "https://audio.test/A-late.mp3" });
    await act(async () => {
      await pendingA.promise;
      await Promise.resolve();
    });

    expect(audio.src).toBe("https://audio.test/B.mp3");
    expect(useMusicStore.getState().currentAudioUrl).toBe(
      "https://audio.test/B.mp3"
    );
    expect(useMusicStore.getState().isPlaying).toBe(true);
    expect(audio.play).toHaveBeenCalledOnce();
    cleanup();
  });

  it("starts a preloaded next track before readiness after the current track ends", async () => {
    const trackA = makeTrack("ended-a");
    const trackB = makeTrack("ended-b");
    const urlA = "https://audio.test/ended-a.mp3";
    const urlB = "https://audio.test/ended-b.mp3";
    let releaseNextReadiness: (() => void) | undefined;

    resolver.resolveTrackUrl.mockImplementation(async (track: MusicTrack) => ({
      url: track.id === trackA.id ? urlA : urlB,
    }));
    useUrlCacheStore
      .getState()
      .set(
        buildUrlCacheKey(trackB.source, trackB.id, trackB.url_id, "192"),
        urlB
      );
    useMusicStore.setState({ queue: [trackA, trackB], currentIndex: 0 });

    const { audio, cleanup } = setup((element) => {
      if (element.src === urlB) {
        releaseNextReadiness = () =>
          element.dispatchEvent(new Event("canplay"));
        return;
      }
      queueMicrotask(() => element.dispatchEvent(new Event("canplay")));
    });

    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
    audio.pause();

    await act(async () => {
      audio.dispatchEvent(new Event("ended"));
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(useMusicStore.getState().currentIndex).toBe(1);
      expect(audio.src).toBe(urlB);
      expect(audio.play).toHaveBeenCalledTimes(2);
    });
    expect(releaseNextReadiness).toBeTypeOf("function");
    expect(useMusicStore.getState().isLoading).toBe(true);
    expect(
      resolver.resolveTrackUrl.mock.calls.filter(
        ([track]) => (track as MusicTrack).id === trackB.id
      )
    ).toHaveLength(0);

    await act(async () => {
      releaseNextReadiness?.();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(useMusicStore.getState().isLoading).toBe(false);
      expect(audio.paused).toBe(false);
    });
    cleanup();
  });

  it("keeps the next track selected when autoplay policy blocks continuation", async () => {
    const trackA = makeTrack("blocked-a");
    const trackB = makeTrack("blocked-b");
    const urlA = "https://audio.test/blocked-a.mp3";
    const urlB = "https://audio.test/blocked-b.mp3";

    resolver.resolveTrackUrl.mockImplementation(async (track: MusicTrack) => ({
      url: track.id === trackA.id ? urlA : urlB,
    }));
    useUrlCacheStore
      .getState()
      .set(
        buildUrlCacheKey(trackB.source, trackB.id, trackB.url_id, "192"),
        urlB
      );
    useMusicStore.setState({ queue: [trackA, trackB], currentIndex: 0 });

    const { audio, cleanup } = setup((element) => {
      if (element.src === urlB) return;
      queueMicrotask(() => element.dispatchEvent(new Event("canplay")));
    });
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());

    audio.pause();
    vi.mocked(audio.play).mockRejectedValueOnce(
      new DOMException("Playback requires activation", "NotAllowedError")
    );
    await act(async () => {
      audio.dispatchEvent(new Event("ended"));
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(useMusicStore.getState().isPlaying).toBe(false);
      expect(useMusicStore.getState().isLoading).toBe(false);
    });
    expect(useMusicStore.getState().currentIndex).toBe(1);
    expect(useMusicStore.getState().currentAudioUrl).toBe(urlB);
    expect(useMusicStore.getState().urlRecoveryKey).toBe(0);
    expect(useMusicStore.getState().consecutiveFailures).toBe(0);
    expect(resolver.invalidateTrackUrlCache).not.toHaveBeenCalled();
    expect(audioMatch.handleAutoMatch).not.toHaveBeenCalled();
    expect(audio.dataset.terminalLoadFailure).toBeUndefined();
    cleanup();
  });

  it("retries an interrupted early play when the user resumes before readiness", async () => {
    const trackA = makeTrack("resume-a");
    const trackB = makeTrack("resume-b");
    const urlA = "https://audio.test/resume-a.mp3";
    const urlB = "https://audio.test/resume-b.mp3";
    let releaseNextReadiness: (() => void) | undefined;
    let rejectEarlyPlay: ((reason?: unknown) => void) | undefined;

    resolver.resolveTrackUrl.mockImplementation(async (track: MusicTrack) => ({
      url: track.id === trackA.id ? urlA : urlB,
    }));
    useUrlCacheStore
      .getState()
      .set(
        buildUrlCacheKey(trackB.source, trackB.id, trackB.url_id, "192"),
        urlB
      );
    useMusicStore.setState({ queue: [trackA, trackB], currentIndex: 0 });

    const { audio, cleanup } = setup((element) => {
      if (element.src === urlB) {
        releaseNextReadiness = () =>
          element.dispatchEvent(new Event("canplay"));
        return;
      }
      queueMicrotask(() => element.dispatchEvent(new Event("canplay")));
    });
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());

    vi.mocked(audio.play).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectEarlyPlay = reject;
        })
    );
    audio.pause();
    await act(async () => {
      audio.dispatchEvent(new Event("ended"));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(audio.play).toHaveBeenCalledTimes(2);
      expect(rejectEarlyPlay).toBeTypeOf("function");
      expect(releaseNextReadiness).toBeTypeOf("function");
    });

    await act(async () => {
      useMusicStore.setState({ isPlaying: false });
      audio.pause();
      rejectEarlyPlay?.(new DOMException("Play interrupted", "AbortError"));
      await Promise.resolve();
      useMusicStore.setState({ isPlaying: true });
      releaseNextReadiness?.();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(audio.play).toHaveBeenCalledTimes(3);
      expect(audio.paused).toBe(false);
      expect(useMusicStore.getState().isPlaying).toBe(true);
      expect(useMusicStore.getState().isLoading).toBe(false);
    });
    expect(useMusicStore.getState().currentIndex).toBe(1);
    expect(useMusicStore.getState().urlRecoveryKey).toBe(0);
    cleanup();
  });

  it("restarts a pending load when an identical track moves to another queue index", async () => {
    const first = makeTrack("duplicate");
    const second = { ...first, name: "Duplicate at index 1" };
    const stale = deferred<{ url: string }>();
    const winningUrl = "https://audio.test/duplicate-index-1.mp3";
    resolver.resolveTrackUrl
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ url: winningUrl });

    useMusicStore.setState({ queue: [first, second], currentIndex: 0 });
    const { audio, cleanup } = setup((element) => {
      queueMicrotask(() => element.dispatchEvent(new Event("canplay")));
    });

    await vi.waitFor(() => {
      expect(resolver.resolveTrackUrl).toHaveBeenCalledOnce();
    });
    const staleSignal = resolver.resolveTrackUrl.mock.calls[0]?.[2] as
      AbortSignal | undefined;

    await act(async () => {
      useMusicStore.setState({ currentIndex: 1 });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(resolver.resolveTrackUrl).toHaveBeenCalledTimes(2);
      expect(audio.play).toHaveBeenCalledOnce();
    });
    expect(staleSignal?.aborted).toBe(true);

    stale.resolve({ url: "https://audio.test/stale-index-0.mp3" });
    await act(async () => {
      await stale.promise;
      await Promise.resolve();
    });

    expect(useMusicStore.getState().currentIndex).toBe(1);
    expect(useMusicStore.getState().currentAudioUrl).toBe(winningUrl);
    expect(audio.src).toBe(winningUrl);
    expect(audio.play).toHaveBeenCalledOnce();
    cleanup();
  });

  it("reloads ready media when the same identity belongs to a new queue position", async () => {
    const first = makeTrack("ready-duplicate");
    const second = { ...first, name: "Same recording at index 1" };
    const sameUrl = "https://audio.test/ready-duplicate.mp3";
    resolver.resolveTrackUrl.mockResolvedValue({ url: sameUrl });
    useMusicStore.setState({
      queue: [first, second],
      currentIndex: 0,
      playbackContextEpoch: 0,
    });
    const { audio, cleanup } = setup((element) => {
      queueMicrotask(() => element.dispatchEvent(new Event("canplay")));
    });

    await vi.waitFor(() => {
      expect(audio.play).toHaveBeenCalledOnce();
      expect(audio.load).toHaveBeenCalledOnce();
    });

    await act(async () => {
      useMusicStore.getState().setCurrentIndexAndPlay(1);
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(resolver.resolveTrackUrl).toHaveBeenCalledTimes(2);
      expect(audio.load).toHaveBeenCalledTimes(2);
      expect(audio.play).toHaveBeenCalledTimes(2);
    });
    expect(useMusicStore.getState().currentIndex).toBe(1);
    expect(audio.src).toBe(sameUrl);
    cleanup();
  });

  it("does not treat a changed url_id as the same loaded track", async () => {
    const first = makeTrack("same-provider-id");
    const replacement = {
      ...first,
      url_id: "replacement-url-id",
      name: "Replacement URL identity",
    };
    resolver.resolveTrackUrl.mockImplementation(async (track: MusicTrack) => ({
      url: `https://audio.test/${track.url_id}.mp3`,
    }));

    useMusicStore.setState({ queue: [first], currentIndex: 0 });
    const { audio, cleanup } = setup((element) => {
      queueMicrotask(() => element.dispatchEvent(new Event("canplay")));
    });

    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());

    await act(async () => {
      useMusicStore.setState({ queue: [replacement] });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(resolver.resolveTrackUrl).toHaveBeenCalledTimes(2);
      expect(audio.play).toHaveBeenCalledTimes(2);
    });
    expect(resolver.resolveTrackUrl.mock.calls[1]?.[0]).toEqual(replacement);
    expect(audio.src).toBe("https://audio.test/replacement-url-id.mp3");
    cleanup();
  });

  it("keeps a pending request alive across a same-identity metadata update", async () => {
    const track = makeTrack("metadata");
    const pending = deferred<{ url: string }>();
    const resolvedUrl = "https://audio.test/metadata.mp3";
    resolver.resolveTrackUrl.mockReturnValue(pending.promise);

    useMusicStore.setState({ queue: [track], currentIndex: 0 });
    const { audio, cleanup } = setup((element) => {
      queueMicrotask(() => element.dispatchEvent(new Event("canplay")));
    });

    await vi.waitFor(() => {
      expect(resolver.resolveTrackUrl).toHaveBeenCalledOnce();
      expect(useMusicStore.getState().isLoading).toBe(true);
    });
    const activeSignal = resolver.resolveTrackUrl.mock.calls[0][2] as
      AbortSignal | undefined;

    await act(async () => {
      useMusicStore.setState({
        queue: [{ ...track, name: "Updated metadata only" }],
      });
      await Promise.resolve();
    });

    expect(activeSignal?.aborted).toBe(false);
    expect(resolver.resolveTrackUrl).toHaveBeenCalledOnce();
    expect(useMusicStore.getState().isLoading).toBe(true);

    pending.resolve({ url: resolvedUrl });
    await vi.waitFor(() => {
      expect(audio.play).toHaveBeenCalledOnce();
      expect(useMusicStore.getState().isLoading).toBe(false);
    });

    expect(audio.src).toBe(resolvedUrl);
    expect(useMusicStore.getState().currentAudioUrl).toBe(resolvedUrl);
    expect(resolver.resolveTrackUrl).toHaveBeenCalledOnce();
    cleanup();
  });

  it("does not resume after the user pauses while media readiness is pending", async () => {
    const track = makeTrack("pause-during-load");
    resolver.resolveTrackUrl.mockResolvedValue({
      url: "https://audio.test/pause-during-load.mp3",
    });
    useMusicStore.setState({ queue: [track], currentIndex: 0 });

    let finishReadiness!: () => void;
    const { audio, cleanup } = setup((element) => {
      finishReadiness = () => element.dispatchEvent(new Event("canplay"));
    });

    await vi.waitFor(() => {
      expect(finishReadiness).toBeTypeOf("function");
      expect(useMusicStore.getState().isLoading).toBe(true);
    });

    await act(async () => {
      useMusicStore.setState({ isPlaying: false });
      finishReadiness();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(useMusicStore.getState().isLoading).toBe(false);
    });
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.paused).toBe(true);
    expect(useMusicStore.getState().isPlaying).toBe(false);
    cleanup();
  });

  it("clears loading when a quality-only URL reload is intentionally skipped", async () => {
    const track: MusicTrack = {
      ...makeTrack("direct-url"),
      source: "url",
      url_id: "https://audio.test/direct.mp3",
    };
    resolver.resolveTrackUrl.mockResolvedValue({ url: track.url_id });
    useMusicStore.setState({ queue: [track], currentIndex: 0 });
    const { audio, cleanup } = setup((element) => {
      queueMicrotask(() => element.dispatchEvent(new Event("canplay")));
    });

    await vi.waitFor(() => {
      expect(audio.play).toHaveBeenCalledOnce();
      expect(useMusicStore.getState().isLoading).toBe(false);
    });

    await act(async () => {
      useMusicStore.setState({ isLoading: true, quality: "320" });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(useMusicStore.getState().isLoading).toBe(false);
    });
    expect(resolver.resolveTrackUrl).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledOnce();
    cleanup();
  });

  it("switches directly to the resolved URL without an intermediate empty load", async () => {
    const track = makeTrack("direct-switch");
    const resolvedUrl = "https://audio.test/direct-switch.mp3";
    const loadedUrls: string[] = [];
    resolver.resolveTrackUrl.mockResolvedValue({ url: resolvedUrl });
    useMusicStore.setState({ queue: [track], currentIndex: 0 });

    const { audio, cleanup } = setup((element) => {
      loadedUrls.push(element.src);
      queueMicrotask(() => element.dispatchEvent(new Event("canplay")));
    });

    await vi.waitFor(() => {
      expect(audio.play).toHaveBeenCalledOnce();
      expect(useMusicStore.getState().isLoading).toBe(false);
    });

    expect(loadedUrls).toEqual([resolvedUrl]);
    expect(audio.load).toHaveBeenCalledOnce();
    expect(resolver.resolveTrackUrl).toHaveBeenCalledOnce();
    expect(useMusicStore.getState().urlRecoveryKey).toBe(0);
    cleanup();
  });

  it.each([
    { proxyEnabled: true, expectedProxyLoads: 1 },
    { proxyEnabled: false, expectedProxyLoads: 0 },
  ])(
    "refreshes a failed signed URL with proxy fallback=$proxyEnabled",
    async ({ proxyEnabled, expectedProxyLoads }) => {
      const track = makeTrack("recover");
      const oldUrl = "https://audio.test/old-signed.mp3";
      const newUrl = "https://audio.test/new-signed.mp3";
      const sequence: string[] = [];
      let resolution = 0;

      resolver.resolveTrackUrl.mockImplementation(async () => {
        resolution += 1;
        sequence.push(`resolve:${resolution}`);
        return { url: resolution === 1 ? oldUrl : newUrl };
      });
      resolver.invalidateTrackUrlCache.mockImplementation(async () => {
        sequence.push("invalidate");
      });
      useMusicStore.setState({
        queue: [track],
        currentIndex: 0,
        enableProxyFallback: proxyEnabled,
      });

      const { audio, cleanup } = setup((element) => {
        const loadedUrl = element.src;
        sequence.push(`load:${loadedUrl}`);
        queueMicrotask(() => {
          element.dispatchEvent(
            new Event(loadedUrl === newUrl ? "canplay" : "error")
          );
        });
      });

      await vi.waitFor(() => {
        expect(useMusicStore.getState().currentAudioUrl).toBe(newUrl);
        expect(audio.play).toHaveBeenCalledTimes(proxyEnabled ? 3 : 2);
      });

      const proxyLoads = sequence.filter((item) =>
        item.startsWith("load:https://proxy.test/proxy")
      );
      expect(proxyLoads).toHaveLength(expectedProxyLoads);
      expect(sequence.indexOf("invalidate")).toBeGreaterThan(
        sequence.indexOf(`load:${oldUrl}`)
      );
      if (proxyEnabled) {
        expect(sequence.indexOf("invalidate")).toBeGreaterThan(
          sequence.findIndex((item) =>
            item.startsWith("load:https://proxy.test/proxy")
          )
        );
      }
      expect(sequence.indexOf("resolve:2")).toBeGreaterThan(
        sequence.indexOf("invalidate")
      );
      expect(resolver.invalidateTrackUrlCache).toHaveBeenCalledWith(
        track,
        192,
        expect.any(AbortSignal)
      );
      expect(useMusicStore.getState().consecutiveFailures).toBe(0);
      expect(audio.src).toBe(newUrl);
      cleanup();
    }
  );

  it.each([
    "/music-api/audio?source=joox&id=dHJhY2s=&br=192",
    "/music-api/netease/audio?id=123&br=320000",
    "/music-api/qqmusic/audio?songmid=abc&quality=320k",
    "/music-api/migu/audio?copyrightId=a&contentId=b&br=192",
    "/music-api/bilibili/audio?bvid=BV1xx411c7mD&cid=2164311",
  ])(
    "never nests an opaque media endpoint in the general proxy: %s",
    async (opaqueUrl) => {
      const track = makeTrack("opaque-terminal");
      resolver.resolveTrackUrl.mockResolvedValue({ url: opaqueUrl });
      useMusicStore.setState({
        queue: [track],
        currentIndex: 0,
        enableProxyFallback: true,
        maxConsecutiveFailures: 1,
      });

      const { audio, cleanup } = setup((element) => {
        queueMicrotask(() => element.dispatchEvent(new Event("error")));
      });

      await vi.waitFor(() => {
        expect(useMusicStore.getState().isPlaying).toBe(false);
        expect(useMusicStore.getState().isLoading).toBe(false);
      });

      expect(api.getProxyUrl).not.toHaveBeenCalled();
      expect(resolver.resolveTrackUrl).toHaveBeenCalledTimes(2);
      expect(resolver.invalidateTrackUrlCache).toHaveBeenCalledOnce();
      expect(audio.load).toHaveBeenCalledTimes(2);
      expect(useMusicStore.getState().urlRecoveryKey).toBe(1);
      expect(audio.src).toBe(new URL(opaqueUrl, window.location.href).href);
      cleanup();
    }
  );

  it("allows auto-match to replace a failing opaque source without proxying it", async () => {
    const original = makeTrack("opaque-auto-match");
    const replacement: MusicTrack = {
      ...makeTrack("matched-source"),
      source: "kuwo",
    };
    const opaqueUrl = "/music-api/qqmusic/audio?songmid=opaque&quality=320k";
    const matchedUrl = "https://audio.test/matched-source.mp3";

    resolver.resolveTrackUrl.mockImplementation(async (track: MusicTrack) => ({
      url: track.source === replacement.source ? matchedUrl : opaqueUrl,
    }));
    audioMatch.handleAutoMatch.mockImplementationOnce(async () => {
      useMusicStore.setState({ queue: [replacement] });
      return true;
    });
    useMusicStore.setState({
      queue: [original],
      currentIndex: 0,
      enableAutoMatch: true,
      enableProxyFallback: true,
    });

    const { audio, cleanup } = setup((element) => {
      queueMicrotask(() =>
        element.dispatchEvent(
          new Event(element.src === matchedUrl ? "canplay" : "error")
        )
      );
    });

    await vi.waitFor(() => {
      expect(useMusicStore.getState().queue[0]).toEqual(replacement);
      expect(audio.src).toBe(matchedUrl);
      expect(audio.play).toHaveBeenCalledTimes(2);
    });

    expect(audioMatch.handleAutoMatch).toHaveBeenCalledOnce();
    expect(api.getProxyUrl).not.toHaveBeenCalled();
    expect(resolver.invalidateTrackUrlCache).not.toHaveBeenCalled();
    cleanup();
  });

  it("forces a reload when URL recovery returns the identical URL", async () => {
    const track = makeTrack("same-url-recovery");
    const sameUrl = "https://audio.test/same-signed.mp3";
    let loadCount = 0;
    resolver.resolveTrackUrl.mockResolvedValue({ url: sameUrl });
    useMusicStore.setState({ queue: [track], currentIndex: 0 });

    const { audio, cleanup } = setup((element) => {
      loadCount += 1;
      queueMicrotask(() => {
        element.dispatchEvent(new Event(loadCount === 1 ? "error" : "canplay"));
      });
    });

    await vi.waitFor(() => {
      expect(audio.play).toHaveBeenCalledTimes(2);
      expect(useMusicStore.getState().isLoading).toBe(false);
    });

    expect(resolver.resolveTrackUrl).toHaveBeenCalledTimes(2);
    expect(resolver.invalidateTrackUrlCache).toHaveBeenCalledOnce();
    expect(audio.load).toHaveBeenCalledTimes(2);
    expect(audio.src).toBe(sameUrl);
    expect(useMusicStore.getState().urlRecoveryKey).toBe(1);
    cleanup();
  });

  it("forces a reload when a quality change resolves to the identical URL", async () => {
    const track = makeTrack("same-url-quality");
    const sameUrl = "https://audio.test/same-for-all-qualities.mp3";
    resolver.resolveTrackUrl.mockResolvedValue({ url: sameUrl });
    useMusicStore.setState({ queue: [track], currentIndex: 0 });

    const { audio, cleanup } = setup((element) => {
      queueMicrotask(() => element.dispatchEvent(new Event("canplay")));
    });

    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());

    await act(async () => {
      useMusicStore.setState({ quality: "320" });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(resolver.resolveTrackUrl).toHaveBeenCalledTimes(2);
      expect(audio.play).toHaveBeenCalledTimes(2);
    });
    expect(audio.load).toHaveBeenCalledTimes(2);
    expect(audio.src).toBe(sameUrl);
    expect(resolver.resolveTrackUrl.mock.calls[1]?.[1]).toBe(320);
    cleanup();
  });

  it("keeps a terminal failure from creating a delayed third recovery", async () => {
    const track = makeTrack("terminal-failure");
    const failedUrl = "https://audio.test/terminal-failure.mp3";
    resolver.resolveTrackUrl.mockResolvedValue({ url: failedUrl });
    useMusicStore.setState({
      queue: [track],
      currentIndex: 0,
      maxConsecutiveFailures: 1,
    });

    const { audio, cleanup } = setup((element) => {
      queueMicrotask(() => element.dispatchEvent(new Event("error")));
    });

    await vi.waitFor(() => {
      expect(useMusicStore.getState().isLoading).toBe(false);
      expect(useMusicStore.getState().isPlaying).toBe(false);
      expect(resolver.resolveTrackUrl).toHaveBeenCalledTimes(2);
    });

    expect(audio.src).toBe(failedUrl);
    expect(audio.getAttribute("src")).toBe(failedUrl);
    expect(audio.dataset.terminalLoadFailure).toBeTruthy();
    expect(useMusicStore.getState().urlRecoveryKey).toBe(1);

    audio.dispatchEvent(new Event("error"));
    expect(useMusicStore.getState().urlRecoveryKey).toBe(1);
    cleanup();
  });
});
