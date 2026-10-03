import { useEffect, useRef } from "react";
import { throttle } from "@/lib/utils";
import { useMusicStore, type MusicState } from "@/store/music-store";
import { useSourceQualityStore } from "@/store/source-quality-store";
import toast from "react-hot-toast";
import { logger } from "@/lib/logger";
import { syncMediaSessionPosition } from "@/lib/media-session";
import { getTrackIdentityKey } from "@/lib/utils/track-identity";
import { markOfflineRouteBroken } from "@/lib/offline-audio";

const PAUSE_CONFIRM_DELAY_MS = 200;
const MAX_AUTO_MATCH_PER_TRACK = 3;

function autoMatchOwnerKey(state: MusicState): string {
  const track = state.queue[state.currentIndex];
  return track
    ? JSON.stringify([
        state.playbackContextEpoch,
        state.currentIndex,
        getTrackIdentityKey(track),
      ])
    : "";
}

export function useAudioEventHandlers(
  audioRef: React.RefObject<HTMLAudioElement | null>,
  isSwitchingTrackRef: React.MutableRefObject<boolean>,
  hasRecordedRef: React.MutableRefObject<boolean>
) {
  const autoMatchRef = useRef({ ownerKey: "", count: 0 });
  const autoMatchRequestRef = useRef<{
    ownerKey: string;
    controller: AbortController;
  } | null>(null);
  const recoveryAttemptedRef = useRef(false);
  const pauseTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // 缓存 getState 方法以减少代码冗余
    const getMusicState = useMusicStore.getState;

    const toggleLoading = (isLoading: boolean) => {
      const state = getMusicState();
      if (state.isLoading !== isLoading) state.setIsLoading(isLoading);
      if (!isLoading) toast.dismiss("audio-loading");
    };

    const syncPositionState = () => syncMediaSessionPosition(audio);

    const unsubscribeOwner = useMusicStore.subscribe((state) => {
      const request = autoMatchRequestRef.current;
      if (!request || request.ownerKey === autoMatchOwnerKey(state)) return;
      request.controller.abort();
      autoMatchRequestRef.current = null;
    });

    const clearPauseTimer = () => {
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
    };

    const handlers: Record<string, EventListener> = {
      timeupdate: throttle(() => {
        if (isSwitchingTrackRef.current) return;
        if (!audio.paused) clearPauseTimer();

        const state = getMusicState();
        // Nobody sees the UI while hidden; skip per-second store updates
        // (and the re-renders/persistence they trigger) until visible again.
        if (document.visibilityState !== "hidden") {
          state.setAudioCurrentTime(audio.currentTime);
        }
        if (!audio.paused && !state.isPlaying) state.setIsPlaying(true);
        // Lock-screen position is synced on play/pause/seek/duration changes;
        // the OS extrapolates in between, so no per-second update is needed.
      }, 1000),

      durationchange: () => {
        const state = getMusicState();
        const track = state.queue[state.currentIndex];
        const eventOwnerKey = autoMatchOwnerKey(state);
        if (
          autoMatchRequestRef.current &&
          autoMatchRequestRef.current.ownerKey !== eventOwnerKey
        ) {
          autoMatchRequestRef.current.controller.abort();
          autoMatchRequestRef.current = null;
        }
        const duration = audio.duration || 0;
        state.setDuration(duration);
        syncPositionState();

        // 检测网易云试听片段（音频时长可能是浮点型）
        const isNeteaseSample =
          [30, 45, 60].some((d) => Math.abs(duration - d) < 1) ||
          audio.src.includes("jdusicrep-ts");
        if (
          state.enableAutoMatch &&
          track?.source === "_netease" &&
          isNeteaseSample
        ) {
          const ownerKey = eventOwnerKey;
          const am = autoMatchRef.current;
          if (am.ownerKey !== ownerKey) {
            am.ownerKey = ownerKey;
            am.count = 0;
            autoMatchRequestRef.current?.controller.abort();
            autoMatchRequestRef.current = null;
          }

          // durationchange can fire repeatedly for the same resource. Do not
          // create concurrent searches for one owner tuple.
          if (autoMatchRequestRef.current?.ownerKey === ownerKey) return;

          if (am.count < MAX_AUTO_MATCH_PER_TRACK) {
            am.count++;
            const controller = new AbortController();
            autoMatchRequestRef.current = { ownerKey, controller };
            void import("@/lib/audio-match")
              .then(({ handleAutoMatch }) =>
                handleAutoMatch(track, undefined, undefined, controller.signal)
              )
              .catch((error) => {
                if (controller.signal.aborted) return;
                logger.warn("useAudioEventHandlers", "Auto match failed", {
                  trackId: track.id,
                  source: track.source,
                  error: error instanceof Error ? error.message : String(error),
                });
              })
              .finally(() => {
                if (autoMatchRequestRef.current?.controller === controller) {
                  autoMatchRequestRef.current = null;
                }
              });
          }
        }
      },

      ended: () => {
        syncPositionState();
        const state = getMusicState();

        if (state.isRepeat) {
          audio.currentTime = 0;
          audio.play().catch(() => state.setIsPlaying(false));
        } else if (state.queue.length) {
          state.setCurrentIndexAndPlay(
            (state.currentIndex + 1) % state.queue.length
          );
        }
      },

      pause: () => {
        syncPositionState();
        if (isSwitchingTrackRef.current || audio.ended || audio.error) return;

        clearPauseTimer();
        pauseTimerRef.current = setTimeout(() => {
          if (
            isSwitchingTrackRef.current ||
            audio.ended ||
            audio.error ||
            !audio.paused
          )
            return;
          getMusicState().setIsPlaying(false);
        }, PAUSE_CONFIRM_DELAY_MS);
      },

      play: () => {
        clearPauseTimer();
        syncPositionState();
        toggleLoading(false);
        if (audio.paused) return;

        recoveryAttemptedRef.current = false;
        const state = getMusicState();
        const track = state.queue[state.currentIndex];

        if (!state.isPlaying) state.setIsPlaying(true);
        state.resetFailures();

        if (!hasRecordedRef.current && track) {
          hasRecordedRef.current = true;
          useSourceQualityStore.getState().recordSuccess(track.source);
          // Play history is intentionally not recorded (saves battery).
        }
      },

      error: () => {
        clearPauseTimer();
        // URL resolution/readiness and deliberate src replacement are owned
        // by useAudioTrackLoader while a switch is in progress. Handling the
        // same event here would start a second recovery, invalidate the URL
        // that just succeeded, and can reload the same recording twice.
        if (isSwitchingTrackRef.current) return;
        const state = getMusicState();

        // A terminal loader failure intentionally leaves the failed source in
        // place rather than assigning an empty src. Ignore any delayed native
        // error for that source until the next owned load removes this marker.
        if (audio.dataset.terminalLoadFailure) return;

        // The loader owns the first media error while a direct remote URL is
        // being prepared: it immediately tries the proxy once. If that proxy
        // also errors, this marker has already been removed and normal URL
        // recovery proceeds below.
        if (audio.dataset.proxyFallbackRequest) return;

        // WebKit may refuse media loads through the worker route; switch the
        // offline copies to blob: URLs so the recovery below can succeed.
        if (audio.src.includes("/offline-audio?")) {
          audio.dataset.offlineRouteBroken = "1";
          markOfflineRouteBroken();
        }

        if (!recoveryAttemptedRef.current && state.queue.length > 0) {
          recoveryAttemptedRef.current = true;
          logger.warn(
            "useAudioEventHandlers",
            "Audio error, attempting URL recovery"
          );
          state.incrementUrlRecoveryKey();
        } else {
          logger.error("useAudioEventHandlers", "Audio error");
          state.setIsPlaying(false);
          syncPositionState();
        }
      },

      loadstart: () => toggleLoading(true),
      waiting: () => toggleLoading(true),
      canplay: () => toggleLoading(false),
      playing: () => {
        clearPauseTimer();
        toggleLoading(false);
      },
      loadedmetadata: () => toggleLoading(false),
      seeked: syncPositionState,
      ratechange: syncPositionState,
    };

    Object.entries(handlers).forEach(([event, handler]) =>
      audio.addEventListener(event, handler)
    );

    // Refresh the on-screen position when returning to the app.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") return;
      if (!isSwitchingTrackRef.current) {
        getMusicState().setAudioCurrentTime(audio.currentTime);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearPauseTimer();
      autoMatchRequestRef.current?.controller.abort();
      autoMatchRequestRef.current = null;
      unsubscribeOwner();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      Object.entries(handlers).forEach(([event, handler]) =>
        audio.removeEventListener(event, handler)
      );
    };
  }, [audioRef, isSwitchingTrackRef, hasRecordedRef]);

  return null;
}
