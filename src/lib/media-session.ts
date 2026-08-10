export function getBrowserMediaSession(): MediaSession | null {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return null;
  }
  return navigator.mediaSession;
}

/**
 * Synchronize the lock-screen position using only values accepted by the Web
 * Media Session API. Invalid/unknown durations clear the previous track state;
 * positions are clamped and playbackRate is always positive.
 */
export function syncMediaSessionPosition(
  media: Pick<HTMLMediaElement, "currentTime" | "duration" | "playbackRate">
): boolean {
  const mediaSession = getBrowserMediaSession();
  if (!mediaSession) return false;

  const duration = media.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    try {
      mediaSession.setPositionState();
    } catch {
      // Older implementations may not support clearing position state.
    }
    return false;
  }

  const rawPosition = Number.isFinite(media.currentTime)
    ? media.currentTime
    : 0;
  const position = Math.min(Math.max(rawPosition, 0), duration);
  const playbackRate =
    Number.isFinite(media.playbackRate) && media.playbackRate > 0
      ? media.playbackRate
      : 1;

  try {
    mediaSession.setPositionState({ duration, playbackRate, position });
    return true;
  } catch {
    return false;
  }
}
