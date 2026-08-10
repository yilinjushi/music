import type { MusicTrack, Playlist } from "@/types/music";
import {
  requireSafeTrack,
  sanitizePlaylistForPersistence,
  sanitizeTrackList,
} from "@/lib/utils/sensitive-data";
import {
  findTrackIdentityIndex,
  getTrackIdentityKey,
  isSameTrackIdentity,
  type TrackIdentity,
} from "@/lib/utils/track-identity";

export const withMeta = (track: MusicTrack): MusicTrack => ({
  ...requireSafeTrack(track),
  update_time: Date.now(),
  is_deleted: track.is_deleted === true,
});

export const cleanPlaylist = (p: Playlist): Playlist => {
  const sanitized = sanitizePlaylistForPersistence(p);
  if (!sanitized) throw new Error("歌单数据不安全或格式无效");
  return sanitized;
};

export const safeTracks = (tracks: unknown): MusicTrack[] =>
  sanitizeTrackList(tracks);

export const clamp = (val: number, max: number) =>
  Math.min(Math.max(val, 0), Math.max(0, max));

export const shuffleArray = <T>(arr: T[]): T[] =>
  [...arr].sort(() => Math.random() - 0.5);

export const updateList = <T extends { id: string }>(
  list: T[],
  id: string,
  updater: Partial<T> | ((item: T) => Partial<T>)
) =>
  list.map((item) =>
    item.id === id
      ? {
          ...item,
          update_time: Date.now(),
          ...(typeof updater === "function" ? updater(item) : updater),
        }
      : item
  );

export const updateTracksByIdentity = (
  tracks: MusicTrack[],
  identity: TrackIdentity,
  updater: Partial<MusicTrack> | ((track: MusicTrack) => Partial<MusicTrack>)
): MusicTrack[] =>
  tracks.map((track) =>
    isSameTrackIdentity(track, identity)
      ? {
          ...track,
          update_time: Date.now(),
          ...(typeof updater === "function" ? updater(track) : updater),
        }
      : track
  );

export const updateOneTrackByIdentity = (
  tracks: MusicTrack[],
  identity: TrackIdentity,
  updater: Partial<MusicTrack> | ((track: MusicTrack) => Partial<MusicTrack>)
): MusicTrack[] => {
  const targetIndex = findTrackIdentityIndex(tracks, identity);
  if (targetIndex < 0) return tracks;
  return tracks.map((track, index) =>
    index === targetIndex
      ? {
          ...track,
          update_time: Date.now(),
          ...(typeof updater === "function" ? updater(track) : updater),
        }
      : track
  );
};

export const updateTrackOccurrences = (
  tracks: MusicTrack[],
  identities: TrackIdentity[],
  updater: Partial<MusicTrack>
): MusicTrack[] =>
  identities.reduce(
    (current, identity) => updateOneTrackByIdentity(current, identity, updater),
    tracks
  );

export const mergeActiveWithTombstones = (
  current: MusicTrack[],
  active: MusicTrack[]
): MusicTrack[] => {
  const activeKeys = new Set(active.map(getTrackIdentityKey));
  return [
    ...active,
    ...current.filter(
      (track) => track.is_deleted && !activeKeys.has(getTrackIdentityKey(track))
    ),
  ];
};

export const replaceActiveWithTombstones = (
  current: MusicTrack[],
  active: MusicTrack[]
): MusicTrack[] =>
  mergeActiveWithTombstones(
    current,
    active.map((track) => ({ ...withMeta(track), is_deleted: false }))
  );
