import type { StateCreator } from "zustand";
import type { MusicState } from "./types";
import type { MusicTrack } from "@/types/music";
import {
  withMeta,
  replaceActiveWithTombstones,
  mergeActiveWithTombstones,
  safeTracks,
  updateOneTrackByIdentity,
  updateTrackOccurrences,
} from "./shared";
import { sanitizeTrackForPersistence } from "@/lib/utils/sensitive-data";
import {
  getTrackIdentityKey,
  isSameTrackIdentity,
  type TrackIdentity,
} from "@/lib/utils/track-identity";

export interface FavoritesSlice {
  favorites: MusicTrack[];
  addToFavorites: (track: MusicTrack) => string | null;
  removeFromFavorites: (track: TrackIdentity) => void;
  restoreFromFavorites: (track: TrackIdentity) => void;
  setFavorites: (tracks: MusicTrack[]) => void;
  replaceActiveFavorites: (tracks: MusicTrack[]) => void;
  reorderFavorites: (tracks: MusicTrack[]) => void;
  isFavorite: (track: TrackIdentity) => boolean;
  addBatchToFavorites: (tracks: MusicTrack[]) => void;
  removeBatchFromFavorites: (tracks: TrackIdentity[]) => void;
}

export const createFavoritesSlice: StateCreator<
  MusicState,
  [],
  [],
  FavoritesSlice
> = (set, get) => ({
  favorites: [],
  addToFavorites: (track) => {
    const safeTrack = sanitizeTrackForPersistence(track);
    if (!safeTrack) return "歌曲包含不安全或无效的数据";
    if (safeTrack.source === "local") return "本地音乐不支持喜欢";
    const { favorites } = get();
    const existing = favorites.find((candidate) =>
      isSameTrackIdentity(candidate, safeTrack)
    );
    if (existing && !existing.is_deleted) return "已在「我的喜欢」中";
    const nextTrack = { ...withMeta(safeTrack), is_deleted: false };
    set({
      favorites: [
        nextTrack,
        ...favorites.filter(
          (candidate) => !isSameTrackIdentity(candidate, safeTrack)
        ),
      ],
    });
    return null;
  },
  removeFromFavorites: (track) =>
    set((s) => ({
      favorites: updateOneTrackByIdentity(s.favorites, track, {
        is_deleted: true,
      }),
    })),
  restoreFromFavorites: (track) =>
    set((s) => ({
      favorites: updateOneTrackByIdentity(s.favorites, track, {
        is_deleted: false,
      }),
    })),
  setFavorites: (favorites) =>
    set({ favorites: safeTracks(favorites).map(withMeta) }),
  replaceActiveFavorites: (favorites) =>
    set((s) => ({
      favorites: replaceActiveWithTombstones(
        s.favorites,
        safeTracks(favorites)
      ),
    })),
  reorderFavorites: (favorites) =>
    set((s) => ({
      favorites: mergeActiveWithTombstones(s.favorites, safeTracks(favorites)),
    })),
  isFavorite: (track) =>
    get().favorites.some(
      (candidate) =>
        isSameTrackIdentity(candidate, track) && !candidate.is_deleted
    ),
  addBatchToFavorites: (tracks) =>
    set((s) => {
      const eligible = safeTracks(tracks).filter((t) => t.source !== "local");
      if (!eligible.length) return s;
      const uniqueEligible = [
        ...new Map(
          eligible.map((track) => [getTrackIdentityKey(track), track])
        ).values(),
      ];
      const activeKeys = new Set(
        s.favorites
          .filter((track) => !track.is_deleted)
          .map((track) => getTrackIdentityKey(track))
      );
      const toAdd = uniqueEligible
        .filter((track) => !activeKeys.has(getTrackIdentityKey(track)))
        .map((t) => ({ ...withMeta(t), is_deleted: false }));
      if (!toAdd.length) return s;
      const keysToAdd = new Set(
        toAdd.map((track) => getTrackIdentityKey(track))
      );
      const base = s.favorites.filter(
        (track) => !keysToAdd.has(getTrackIdentityKey(track))
      );
      return { favorites: [...toAdd, ...base] };
    }),
  removeBatchFromFavorites: (tracks) =>
    set((s) => {
      return {
        favorites: updateTrackOccurrences(s.favorites, tracks, {
          is_deleted: true,
        }),
      };
    }),
});
