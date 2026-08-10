import type { AudioFormat } from "@otter-music/shared";

import {
  getTrackIdentityKey,
  type TrackIdentity,
} from "@/lib/utils/track-identity";

const audioFormatCache = new Map<string, AudioFormat>();

function formatCacheKey(track: TrackIdentity): string {
  return getTrackIdentityKey(track);
}

export function getCachedBilibiliAudioFormat(
  track: TrackIdentity
): AudioFormat | undefined {
  return audioFormatCache.get(formatCacheKey(track));
}

export function setCachedBilibiliAudioFormat(
  track: TrackIdentity,
  format: AudioFormat
): void {
  audioFormatCache.set(formatCacheKey(track), format);
}
