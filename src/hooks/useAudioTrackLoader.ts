import { useEffect, useRef } from "react";
import { getProxyUrl, isProxyUrl } from "@/lib/api";
import { useMusicStore } from "@/store/music-store";
import { useSourceQualityStore } from "@/store/source-quality-store";
import { useUrlCacheStore, buildUrlCacheKey } from "@/store/url-cache-store";
import type { MusicSource } from "@/types/music";
import toast from "react-hot-toast";
import { logger } from "@/lib/logger";
import {
  isSameTrackIdentity,
  normalizeTrackUrlId,
} from "@/lib/utils/track-identity";
import {
  isSameOriginOpaqueAudioUrl,
  normalizeAudioUrlForPlayback,
} from "@/lib/utils/audio-url";

const AUDIO_READY_TIMEOUT = 8000;
type FallbackStage = "none" | "proxy" | "final";

function isPlaybackBlockedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotAllowedError"
  );
}

function isPlayInterruptionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

/** 校验歌曲在当前网络/缓存状态下是否可播（离线时手机里有缓存也算可播） */
async function isTrackPlayable(
  track: { source: MusicSource; id: string } | null
): Promise<boolean> {
  if (!track) return false;
  if (track.source === "local" || navigator.onLine) return true;
  const { hasOfflineAudio } = await import("@/lib/offline-audio");
  return hasOfflineAudio(track);
}

/** 查找队列中下一首可播歌曲 */
async function findNextPlayableTrack(
  queue: { source: MusicSource; id: string }[],
  startIndex: number
): Promise<number | null> {
  if (!queue.length) return null;
  const scanLimit = Math.min(queue.length, 200);
  for (let i = 0; i < scanLimit; i++) {
    const index = (startIndex + i) % queue.length;
    if (await isTrackPlayable(queue[index])) return index;
  }
  return null;
}

/** 将音频加载事件封装为 Promise */
function waitForAudioReady(
  audio: HTMLAudioElement,
  signal: AbortSignal,
  timeout = AUDIO_READY_TIMEOUT,
  acceptCurrentReadyState = true
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("loadedmetadata", onReady);
      audio.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };

    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(
        Object.assign(new Error("AUDIO_NOT_READY"), {
          mediaErrorCode: audio.error?.code ?? null,
        })
      );
    };
    const onAbort = () => {
      cleanup();
      reject(
        Object.assign(new Error("AUDIO_REQUEST_ABORTED"), {
          name: "AbortError",
        })
      );
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("AUDIO_READY_TIMEOUT"));
    }, timeout);

    if (signal.aborted) {
      onAbort();
      return;
    }

    audio.addEventListener("canplay", onReady, { once: true });
    audio.addEventListener("loadedmetadata", onReady, { once: true });
    audio.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });

    // Reusing an already-ready identical URL does not emit another media
    // event. Resolve from the current state instead of waiting for a signal
    // that will never arrive. HAVE_METADATA is sufficient because this helper
    // has always accepted loadedmetadata as readiness.
    if (acceptCurrentReadyState && !audio.error && audio.readyState >= 1) {
      onReady();
    }
  });
}

export function useAudioTrackLoader(
  audioRef: React.RefObject<HTMLAudioElement | null>,
  isSwitchingTrackRef: React.MutableRefObject<boolean>,
  hasRecordedRef: React.MutableRefObject<boolean>
) {
  const currentIndex = useMusicStore((s) => s.currentIndex);
  const currentTrackId = useMusicStore(
    (s) => s.queue[s.currentIndex]?.id ?? null
  );
  const currentTrackSource = useMusicStore(
    (s) => s.queue[s.currentIndex]?.source ?? null
  );
  const currentTrackUrlId = useMusicStore((s) =>
    normalizeTrackUrlId(s.queue[s.currentIndex]?.url_id)
  );
  const playbackContextEpoch = useMusicStore((s) => s.playbackContextEpoch);
  const quality = useMusicStore((s) => s.quality);
  const hasUserGesture = useMusicStore((s) => s.hasUserGesture);
  const urlRecoveryKey = useMusicStore((s) => s.urlRecoveryKey);

  const requestIdRef = useRef(0);
  const remoteUrlRef = useRef<string | null>(null);
  const fallbackStageRef = useRef<{
    trackKey: string | null;
    stage: FallbackStage;
  }>({ trackKey: null, stage: "none" });
  const readyMediaRef = useRef<{
    index: number;
    contextEpoch: number;
    id: string;
    source: MusicSource;
    urlId: string | undefined;
    absoluteUrl: string;
  } | null>(null);
  const prevTrackRef = useRef<{
    index?: number;
    contextEpoch?: number;
    id?: string;
    source?: string;
    urlId?: string;
    quality?: string;
    recoveryKey?: number;
  }>({});

  useEffect(() => {
    const getState = useMusicStore.getState;
    const stateSnapshot = getState();
    const ownerIndex = stateSnapshot.currentIndex;
    const ownerContextEpoch = stateSnapshot.playbackContextEpoch;
    const stateTrack = stateSnapshot.queue[ownerIndex];
    const currentTrack = stateTrack
      ? {
          ...stateTrack,
          artist: [...stateTrack.artist],
          artist_ids: stateTrack.artist_ids
            ? [...stateTrack.artist_ids]
            : undefined,
        }
      : null;
    if (
      !hasUserGesture ||
      !currentTrack?.id ||
      !currentTrack?.source ||
      !audioRef.current
    )
      return;

    const { id: trackId, source } = currentTrack;
    const urlId = normalizeTrackUrlId(currentTrack.url_id);
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    const effectAudio = audioRef.current;
    const trackKey = buildUrlCacheKey(source, trackId, urlId, quality);

    const loadAudio = async () => {
      const audio = effectAudio;
      const prev = prevTrackRef.current;
      const requestMarker = String(requestId);
      const isActive = () => {
        const state = getState();
        const activeTrack = state.queue[state.currentIndex];
        return (
          requestId === requestIdRef.current &&
          !controller.signal.aborted &&
          audioRef.current === audio &&
          state.hasUserGesture &&
          state.currentIndex === ownerIndex &&
          state.playbackContextEpoch === ownerContextEpoch &&
          state.quality === quality &&
          state.urlRecoveryKey === urlRecoveryKey &&
          isSameTrackIdentity(activeTrack, {
            id: trackId,
            source,
            url_id: urlId,
          })
        );
      };
      const assertActive = () => {
        if (!isActive()) {
          throw Object.assign(new Error("AUDIO_REQUEST_SUPERSEDED"), {
            name: "AbortError",
          });
        }
      };
      const clearProxyMarker = () => {
        if (audio.dataset.proxyFallbackRequest === requestMarker) {
          delete audio.dataset.proxyFallbackRequest;
        }
      };

      const isRecovery =
        prev.recoveryKey !== undefined && prev.recoveryKey !== urlRecoveryKey;
      const isSameTrack =
        prev.id === trackId && prev.source === source && prev.urlId === urlId;
      const ownerChanged =
        prev.index !== ownerIndex || prev.contextEpoch !== ownerContextEpoch;
      const qualityChanged = isSameTrack && prev.quality !== quality;
      const skipQualityReload =
        qualityChanged && ["local", "bilibili", "url"].includes(source);
      const readyMedia = readyMediaRef.current;
      const hasReadyOwnedMedia =
        readyMedia?.index === ownerIndex &&
        readyMedia.contextEpoch === ownerContextEpoch &&
        readyMedia.id === trackId &&
        readyMedia.source === source &&
        readyMedia.urlId === urlId &&
        audio.src === readyMedia.absoluteUrl &&
        !audio.error;

      // 无需重新加载的场景
      if (
        isSameTrack &&
        (!qualityChanged || skipQualityReload) &&
        hasReadyOwnedMedia &&
        !isSwitchingTrackRef.current &&
        !isRecovery
      ) {
        // A skipped reload owns no pending work, so it must not inherit a
        // loading flag left by the effect it replaced.
        if (getState().isLoading) getState().setIsLoading(false);
        return;
      }

      assertActive();

      // 状态初始化与缓存清理
      if (
        isRecovery ||
        (qualityChanged && !skipQualityReload) ||
        fallbackStageRef.current.trackKey !== trackKey ||
        !hasReadyOwnedMedia
      ) {
        remoteUrlRef.current = null;
        fallbackStageRef.current = { trackKey, stage: "none" };
        readyMediaRef.current = null;
      }

      isSwitchingTrackRef.current = true;
      hasRecordedRef.current = false;
      getState().setIsLoading(true);

      const resumeTime = qualityChanged
        ? audio.currentTime
        : getState().currentAudioTime;
      // Offline, a remembered network URL is useless: let the resolver pick
      // the copy stored on the phone instead.
      const cachedPrimaryUrl =
        !isRecovery && navigator.onLine
          ? useUrlCacheStore.getState().get(trackKey)
          : undefined;
      if (!qualityChanged) audio.pause();

      if (isRecovery) {
        const { invalidateTrackUrlCache } =
          await import("@/lib/audio-resolver");
        assertActive();
        await invalidateTrackUrlCache(
          currentTrack,
          parseInt(quality, 10),
          controller.signal
        );
        assertActive();
      }

      /** 核心播放器加载逻辑 */
      const play = async (audioUrl: string) => {
        assertActive();
        const canTryProxy =
          getState().enableProxyFallback &&
          source !== "local" &&
          navigator.onLine &&
          !isProxyUrl(audioUrl) &&
          !isSameOriginOpaqueAudioUrl(audioUrl) &&
          fallbackStageRef.current.stage === "none";

        if (canTryProxy) {
          audio.dataset.proxyFallbackRequest = requestMarker;
        } else {
          clearProxyMarker();
        }

        const absoluteAudioUrl = new URL(audioUrl, window.location.href).href;
        const forceReload =
          ownerChanged || isRecovery || (qualityChanged && !skipQualityReload);
        const shouldReload =
          audio.src !== absoluteAudioUrl ||
          forceReload ||
          audio.readyState < 1 ||
          !!audio.error;
        // A new owned load supersedes a terminal marker left by the preceding
        // request. While this request is switching, its errors remain loader-
        // owned through isSwitchingTrackRef.
        delete audio.dataset.terminalLoadFailure;
        assertActive();
        getState().setCurrentAudioUrl(audioUrl);

        // Install readiness listeners before load(): a synthetic media layer
        // or a very fast memory hit may emit loadedmetadata synchronously.
        const readinessController = new AbortController();
        const abortReadiness = () => readinessController.abort();
        if (controller.signal.aborted) abortReadiness();
        else
          controller.signal.addEventListener("abort", abortReadiness, {
            once: true,
          });
        const readiness = waitForAudioReady(
          audio,
          readinessController.signal,
          AUDIO_READY_TIMEOUT,
          !shouldReload
        );
        if (shouldReload) {
          assertActive();
          if (audio.src !== absoluteAudioUrl) audio.src = audioUrl;
          // load() is required even when a recovery/quality request resolves
          // to the same URL; otherwise no readiness event is guaranteed.
          audio.load();
        }
        const shouldStartBeforeReady = resumeTime === 0 && getState().isPlaying;
        if (shouldStartBeforeReady) {
          audio.playbackRate = getState().playbackSpeed;
        }
        // Starting a fresh track before awaiting canplay keeps the browser's
        // continuous media session alive across an ended -> next transition.
        // Convert a user pause interruption into an outcome so a later resume
        // can retry once media is ready. Other failures keep rejecting, and
        // Promise.all below observes them immediately instead of letting a
        // later readiness timeout hide the real play() error.
        const earlyPlayAttempt = shouldStartBeforeReady
          ? audio.play().then(
              () => ({ interrupted: false as const }),
              (error: unknown) => {
                if (isPlayInterruptionError(error)) {
                  return { interrupted: true as const };
                }
                throw error;
              }
            )
          : null;
        try {
          const earlyPlayOutcome = earlyPlayAttempt
            ? (await Promise.all([readiness, earlyPlayAttempt]))[1]
            : null;
          assertActive();
          readyMediaRef.current = {
            index: ownerIndex,
            contextEpoch: ownerContextEpoch,
            id: trackId,
            source,
            urlId,
            absoluteUrl: absoluteAudioUrl,
          };
          // A user can pause while URL resolution or media readiness is still
          // pending. Do not let the completion of that older play request
          // silently turn playback back on after their explicit pause.
          if (!getState().isPlaying) {
            if (!audio.paused) audio.pause();
            return;
          }
          audio.currentTime = resumeTime;
          audio.playbackRate = getState().playbackSpeed;
          assertActive();
          if (!getState().isPlaying) return;
          if (!earlyPlayAttempt || earlyPlayOutcome?.interrupted) {
            await audio.play();
          }
          assertActive();
        } catch (error) {
          // A readiness failure must stop the pending old source, but a stale
          // request must never pause media already owned by a newer track.
          if (
            earlyPlayAttempt &&
            isActive() &&
            audio.src === absoluteAudioUrl
          ) {
            audio.pause();
          }
          throw error;
        } finally {
          controller.signal.removeEventListener("abort", abortReadiness);
          readinessController.abort();
          clearProxyMarker();
        }
      };

      /** 解析获取最佳 URL（内存 URL -> 网络） */
      const resolveOptimalUrl = async () => {
        assertActive();
        // 代理备用线路容灾时，直接使用已缓存的远程 URL
        if (
          remoteUrlRef.current &&
          (navigator.onLine || remoteUrlRef.current.startsWith("blob:"))
        )
          return { url: remoteUrlRef.current };

        const { resolveTrackUrl } = await import("@/lib/audio-resolver");
        assertActive();
        const result = await resolveTrackUrl(
          currentTrack,
          parseInt(quality, 10),
          controller.signal
        );
        assertActive();
        // 同步到 remoteUrlRef 以支持代理备用线路容灾
        if (result.url) {
          remoteUrlRef.current = result.url;
        }
        return result;
      };

      try {
        // useAudioPreloader warms this memory cache near the end of the
        // current track. Consume it synchronously so the normal ended path can
        // set src and request play before yielding to background throttling.
        const primaryUrl = cachedPrimaryUrl
          ? normalizeAudioUrlForPlayback(cachedPrimaryUrl)
          : (await resolveOptimalUrl()).url;
        if (cachedPrimaryUrl) remoteUrlRef.current = primaryUrl;
        assertActive();

        // 离线无资源容灾跳过
        if (!primaryUrl && !navigator.onLine && source !== "local") {
          const state = getState();
          const nextIdx = await findNextPlayableTrack(
            state.queue,
            state.currentIndex + 1
          );
          assertActive();
          if (nextIdx !== null && nextIdx !== state.currentIndex) {
            state.setCurrentIndexAndPlay(nextIdx);
          } else {
            logger.error(
              "useAudioTrackLoader",
              "Network unavailable, no playable tracks",
              { trackId, source }
            );
            state.setIsPlaying(false);
          }
          return;
        }

        try {
          await play(primaryUrl);
          assertActive();
        } catch (err) {
          assertActive();
          if (isPlaybackBlockedError(err)) throw err;

          // 代理备用线路容灾
          if (
            getState().enableProxyFallback &&
            source !== "local" &&
            fallbackStageRef.current.stage === "none" &&
            remoteUrlRef.current &&
            navigator.onLine &&
            !isProxyUrl(remoteUrlRef.current) &&
            !isSameOriginOpaqueAudioUrl(remoteUrlRef.current)
          ) {
            assertActive();
            fallbackStageRef.current.stage = "proxy";
            toast("已切换备用线路", { icon: "🌐", id: "proxy-notice" });
            const proxyUrl = getProxyUrl(remoteUrlRef.current);
            await play(proxyUrl);
            assertActive();
            return;
          }

          throw err;
        }
      } catch (err: unknown) {
        if (!isActive() || (err instanceof Error && err.name === "AbortError"))
          return;

        // Autoplay/user-activation policy is not an audio URL failure. Keep
        // the selected next track and resolved src intact so one user play
        // action can resume it; never poison source health or skip the queue.
        if (isPlaybackBlockedError(err)) {
          logger.warn(
            "useAudioTrackLoader",
            "Browser blocked automatic playback continuation",
            { trackId, source }
          );
          if (audio.paused) getState().setIsPlaying(false);
          toast.error("浏览器阻止了自动续播，请点击播放继续", {
            id: "playback-policy-blocked",
          });
          return;
        }

        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          "useAudioTrackLoader",
          `Audio load failed: ${errorMsg}`,
          err,
          { trackId, source, urlId }
        );

        // 自动匹配容灾
        if (getState().enableAutoMatch) {
          try {
            const { handleAutoMatch } = await import("@/lib/audio-match");
            assertActive();
            const matched = await handleAutoMatch(
              currentTrack,
              undefined,
              undefined,
              controller.signal
            );
            assertActive();
            if (matched) return;
          } catch (autoMatchError) {
            if (!isActive()) return;
            logger.warn("useAudioTrackLoader", "Auto match failed", {
              trackId,
              source,
              error:
                autoMatchError instanceof Error
                  ? autoMatchError.message
                  : String(autoMatchError),
            });
          }
        }

        assertActive();
        // The loader exclusively owns errors raised while a source is being
        // resolved or made ready. If matching did not replace the recording,
        // perform one cache-invalidating retry here; the global media error
        // handler only owns failures that occur after playback is stable.
        if (!isRecovery) {
          getState().incrementUrlRecoveryKey();
          return;
        }

        assertActive();
        useSourceQualityStore.getState().recordFail(source);

        // 离线时清理临时 URL；Web 不把远程音频声明为离线资源。
        if (!navigator.onLine) {
          useUrlCacheStore.getState().delete(trackKey);
        }

        fallbackStageRef.current.stage = "final";
        // Keep the failed URL in the element until the next owned replacement.
        // Assigning an empty src causes Chrome to enqueue a second, late error
        // which the stable-playback handler would misread as a third recovery.
        audio.dataset.terminalLoadFailure = requestMarker;
        audio.pause();
        getState().setCurrentAudioUrl(null);
        toast.error("播放失败，已自动切到下一首");

        const state = getState();
        if (state.incrementFailures() >= state.maxConsecutiveFailures) {
          if (audio.paused) getState().setIsPlaying(false);
          else
            logger.warn(
              "useAudioTrackLoader",
              "Skip setIsPlaying(false) because audio is still playing"
            );
        } else {
          getState().skipToNext();
        }
      } finally {
        if (isActive()) {
          isSwitchingTrackRef.current = false;
          getState().setIsLoading(false);
        }
      }
    };

    loadAudio();
    prevTrackRef.current = {
      index: ownerIndex,
      contextEpoch: ownerContextEpoch,
      id: trackId,
      source,
      urlId,
      quality,
      recoveryKey: urlRecoveryKey,
    };

    return () => {
      clearProxyMarkerForRequest(effectAudio, requestId);
      controller.abort();
      isSwitchingTrackRef.current = false;
      getState().setIsLoading(false);
    };
  }, [
    audioRef,
    currentIndex,
    currentTrackId,
    currentTrackSource,
    currentTrackUrlId,
    playbackContextEpoch,
    quality,
    hasUserGesture,
    hasRecordedRef,
    isSwitchingTrackRef,
    urlRecoveryKey,
  ]);
}

function clearProxyMarkerForRequest(
  audio: HTMLAudioElement | null,
  requestId: number
): void {
  if (audio?.dataset.proxyFallbackRequest === String(requestId)) {
    delete audio.dataset.proxyFallbackRequest;
  }
}
