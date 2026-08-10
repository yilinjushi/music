import type { MusicTrack } from "@/types/music";
import { getExactKey } from "./music-key";
import { useMusicStore } from "@/store/music-store";
import { v4 as uuidv4 } from "uuid";
import {
  assertNoSensitiveData,
  requireSafeDirectAudioUrl,
} from "./sensitive-data";
import { getTrackOccurrenceKeys } from "./track-identity";

export { cleanTrack } from "./clean-track";

// 格式化音视频时间为分秒格式
export const formatMediaTime = (time: number) => {
  if (isNaN(time)) return "0:00";
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

/**
 * 歌单去重结果
 */
interface DeduplicationResult {
  removedCount: number;
  trackRowKeysToDelete: string[];
  tracksToLike: MusicTrack[];
}

/**
 * 歌单去重逻辑
 * @param tracks 原始歌曲列表
 * @param isFavorite 检查歌曲是否已喜欢的回调
 * @param isDownloaded 检查歌曲是否已下载的回调
 * @returns DeduplicationResult
 */
export function deduplicateTracks(
  tracks: MusicTrack[],
  isFavorite: (track: MusicTrack) => boolean,
  isDownloaded: (track: MusicTrack) => boolean
): DeduplicationResult {
  const groups = new Map<string, { track: MusicTrack; index: number }[]>();

  // 1. Grouping
  tracks.forEach((track, index) => {
    const key = getExactKey(track);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push({ track, index });
  });

  const indicesToRemove = new Set<number>();
  const trackRowKeys = getTrackOccurrenceKeys(tracks);
  const trackRowKeysToDelete: string[] = [];
  let removedCount = 0;
  const tracksToLike: MusicTrack[] = [];

  // 2. Selection
  groups.forEach((group) => {
    if (group.length <= 1) return;

    // Check if any track in the group is liked
    const hasLiked = group.some((item) => isFavorite(item.track));

    // Sort to find the winner
    group.sort((a, b) => {
      const aLiked = isFavorite(a.track);
      const bLiked = isFavorite(b.track);
      // Priority 1: Liked (True > False)
      if (aLiked !== bLiked) return aLiked ? -1 : 1;

      const aDown = isDownloaded(a.track);
      const bDown = isDownloaded(b.track);
      // Priority 2: Downloaded (True > False)
      if (aDown !== bDown) return aDown ? -1 : 1;

      // Priority 3: Source order (lower index = higher priority)
      const configs = useMusicStore.getState().sourceConfigs;
      const aOrder = configs.findIndex((c) => c.source === a.track.source);
      const bOrder = configs.findIndex((c) => c.source === b.track.source);
      if (aOrder !== bOrder) {
        if (aOrder === -1) return 1;
        if (bOrder === -1) return -1;
        return aOrder - bOrder;
      }

      // Priority 4: Earlier index wins (ascending) — 新加入可信度更高
      return a.index - b.index;
    });

    const winner = group[0];

    // If the group had a liked track but the winner is not liked, mark it for liking
    if (hasLiked && !isFavorite(winner.track)) {
      tracksToLike.push(winner.track);
    }

    // Mark losers for removal
    for (let i = 1; i < group.length; i++) {
      indicesToRemove.add(group[i].index);
      trackRowKeysToDelete.push(trackRowKeys[group[i].index]);
      removedCount++;
    }
  });

  return {
    removedCount,
    trackRowKeysToDelete,
    tracksToLike,
  };
}

export function createTrackFromUrl(
  title: string,
  url: string,
  artist?: string
): MusicTrack {
  assertNoSensitiveData({ title, artist: artist ?? null });
  const safeUrl = requireSafeDirectAudioUrl(url);
  const artists = artist?.trim()
    ? artist
        .split(/[，,]/)
        .map((a) => a.trim())
        .filter(Boolean) //  中英文逗号都可以分割
    : ["Unknown Artist"];

  return {
    id: uuidv4(),
    name: title,
    artist: artists.length ? artists : ["Unknown Artist"],
    album: "",
    pic_id: "",
    url_id: safeUrl,
    lyric_id: "",
    source: "url",
    update_time: Date.now(),
  };
}
