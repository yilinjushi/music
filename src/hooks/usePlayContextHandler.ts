import { useCallback } from "react";
import { useMusicStore } from "@/store/music-store";
import { getPlayAllStartIndex } from "./usePlayHelper";
import type { MusicTrack } from "@/types/music";
import {
  findTrackIdentityIndex,
  isSameTrackIdentity,
} from "@/lib/utils/track-identity";

export function usePlayContextHandler(list: MusicTrack[], contextId: string) {
  const togglePlay = useMusicStore((s) => s.togglePlay);
  const playContext = useMusicStore((s) => s.playContext);
  const currentTrack = useMusicStore((s) => s.queue[s.currentIndex]);
  const isShuffle = useMusicStore((s) => s.isShuffle);

  return useCallback(
    (track: MusicTrack | null, index?: number) => {
      if (track && isSameTrackIdentity(track, currentTrack)) {
        togglePlay();
        return;
      }
      const idx =
        index ??
        (track
          ? findTrackIdentityIndex(list, track)
          : getPlayAllStartIndex(list.length, isShuffle));
      if (idx < 0) return;
      playContext(list, Math.max(0, idx), contextId);
    },
    [contextId, list, togglePlay, playContext, currentTrack, isShuffle]
  );
}
