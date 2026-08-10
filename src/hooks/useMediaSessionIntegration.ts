import { useEffect } from "react";
import { useMusicStore } from "@/store/music-store";
import { forceHttps } from "@shared/utils/url";
import { getBrowserMediaSession } from "@/lib/media-session";
import { logger } from "@/lib/logger";

export function sanitizeMediaSessionArtworkUrl(
  rawUrl: string | null | undefined
): string | null {
  if (!rawUrl) return null;

  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  const normalized = forceHttps(trimmed);

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.hostname === "localhost") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function clampSeekTime(audio: HTMLAudioElement, requested: number): number {
  if (!Number.isFinite(requested)) return 0;
  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0)
    return Math.max(requested, 0);
  return Math.min(Math.max(requested, 0), duration);
}

export function useMediaSessionIntegration(
  audioRef: React.RefObject<HTMLAudioElement | null>,
  coverUrl: string | null | undefined
) {
  const currentTrack = useMusicStore(
    (state) => state.queue[state.currentIndex]
  );
  const isPlaying = useMusicStore((state) => state.isPlaying);

  useEffect(() => {
    const mediaSession = getBrowserMediaSession();
    if (!mediaSession) return;

    if (!currentTrack) {
      mediaSession.metadata = null;
      return;
    }

    if (typeof MediaMetadata === "undefined") return;

    const safeArtworkUrl = sanitizeMediaSessionArtworkUrl(coverUrl);
    try {
      mediaSession.metadata = new MediaMetadata({
        title: currentTrack.name || "Unknown Track",
        artist: currentTrack.artist?.join("/") || "Unknown Artist",
        album: currentTrack.album || "",
        artwork: safeArtworkUrl ? [{ src: safeArtworkUrl }] : [],
      });
    } catch (error) {
      logger.error("MediaSession", "Failed to update metadata", error);
    }
  }, [currentTrack, coverUrl]);

  useEffect(() => {
    const mediaSession = getBrowserMediaSession();
    if (!mediaSession) return;

    const audio = audioRef.current;
    const syncPlaybackState = () => {
      try {
        mediaSession.playbackState = audio
          ? audio.paused
            ? "paused"
            : "playing"
          : isPlaying
            ? "playing"
            : "paused";
      } catch (error) {
        logger.error("MediaSession", "Failed to update playback state", error);
      }
    };

    syncPlaybackState();
    if (!audio) return;

    const playbackEvents: Array<keyof HTMLMediaElementEventMap> = [
      "play",
      "pause",
      "ended",
      "waiting",
      "stalled",
      "error",
    ];
    playbackEvents.forEach((event) =>
      audio.addEventListener(event, syncPlaybackState)
    );

    return () => {
      playbackEvents.forEach((event) =>
        audio.removeEventListener(event, syncPlaybackState)
      );
    };
  }, [audioRef, isPlaying, currentTrack?.id]);

  useEffect(() => {
    const mediaSession = getBrowserMediaSession();
    if (!mediaSession) return;

    const seek = (requested: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      useMusicStore.getState().seek(clampSeekTime(audio, requested));
    };

    const actionHandlers: Array<
      [MediaSessionAction, MediaSessionActionHandler]
    > = [
      [
        "play",
        () => {
          const state = useMusicStore.getState();
          if (!state.queue[state.currentIndex]) return;
          state.setUserGesture();
          state.setIsPlaying(true);
          const audio = audioRef.current;
          if (!audio) return;
          // On a restored PWA queue there may not be a media source yet. The
          // play intent above wakes the owned track loader; it will call play
          // after the source reaches readiness.
          if (!audio.currentSrc && !audio.getAttribute("src")) return;
          void audio
            .play()
            .catch((error) =>
              logger.error("MediaSession", "Failed to start playback", error)
            );
        },
      ],
      [
        "pause",
        () => {
          useMusicStore.getState().setIsPlaying(false);
          audioRef.current?.pause();
        },
      ],
      [
        "previoustrack",
        () => {
          const { queue, currentIndex, setCurrentIndexAndPlay } =
            useMusicStore.getState();
          if (queue.length === 0) return;
          setCurrentIndexAndPlay(
            currentIndex <= 0 ? queue.length - 1 : currentIndex - 1
          );
        },
      ],
      [
        "nexttrack",
        () => {
          const { queue, currentIndex, setCurrentIndexAndPlay } =
            useMusicStore.getState();
          if (queue.length === 0) return;
          setCurrentIndexAndPlay((currentIndex + 1) % queue.length);
        },
      ],
      [
        "seekto",
        ({ seekTime }) => {
          if (seekTime !== undefined) seek(seekTime);
        },
      ],
      [
        "seekbackward",
        ({ seekOffset }) => {
          const audio = audioRef.current;
          if (audio) seek(audio.currentTime - (seekOffset ?? 10));
        },
      ],
      [
        "seekforward",
        ({ seekOffset }) => {
          const audio = audioRef.current;
          if (audio) seek(audio.currentTime + (seekOffset ?? 10));
        },
      ],
    ];

    const registeredActions: MediaSessionAction[] = [];
    for (const [action, handler] of actionHandlers) {
      try {
        mediaSession.setActionHandler(action, handler);
        registeredActions.push(action);
      } catch (error) {
        logger.error(
          "MediaSession",
          "Failed to register action handler",
          error,
          { action }
        );
      }
    }

    return () => {
      registeredActions.forEach((action) => {
        try {
          mediaSession.setActionHandler(action, null);
        } catch {
          // The browser may stop supporting an action after registration.
        }
      });
    };
  }, [audioRef]);
}
