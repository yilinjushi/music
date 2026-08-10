import type { StateCreator } from "zustand";
import type { MusicState } from "./types";
import type { MusicTrack, Playlist } from "@/types/music";
import { v4 as uuidv4 } from "uuid";
import { toastUtils } from "@/lib/utils/toast";
import {
  withMeta,
  updateList,
  replaceActiveWithTombstones,
  mergeActiveWithTombstones,
  safeTracks,
  updateTracksByIdentity,
  updateOneTrackByIdentity,
  updateTrackOccurrences,
} from "./shared";
import {
  assertNoSensitiveData,
  requireSafePlaylist,
  sanitizeTrackForPersistence,
} from "@/lib/utils/sensitive-data";
import {
  getTrackIdentityKey,
  isSameTrackIdentity,
  type TrackIdentity,
} from "@/lib/utils/track-identity";

export interface PlaylistSlice {
  playlists: Playlist[];
  createPlaylist: (
    name: string,
    coverUrl?: string,
    tracks?: MusicTrack[]
  ) => string;
  deletePlaylist: (id: string) => void;
  restorePlaylist: (id: string) => void;
  renamePlaylist: (id: string, name: string) => void;
  updatePlaylist: (id: string, data: Partial<Playlist>) => void;
  addToPlaylist: (playlistId: string, track: MusicTrack) => void;
  addBatchToPlaylist: (playlistId: string, tracks: MusicTrack[]) => void;
  removeBatchFromPlaylist: (
    playlistId: string,
    tracks: TrackIdentity[]
  ) => void;
  removeFromPlaylist: (playlistId: string, track: TrackIdentity) => void;
  setPlaylistTracks: (playlistId: string, tracks: MusicTrack[]) => void;
  replaceActivePlaylistTracks: (
    playlistId: string,
    tracks: MusicTrack[]
  ) => void;
  reorderPlaylistTracks: (playlistId: string, tracks: MusicTrack[]) => void;
}

export const createPlaylistSlice: StateCreator<
  MusicState,
  [],
  [],
  PlaylistSlice
> = (set) => ({
  playlists: [],
  createPlaylist: (name, coverUrl, tracks = []) => {
    assertNoSensitiveData({ name, coverUrl: coverUrl ?? null });
    const persistedTracks = safeTracks(tracks);
    if (persistedTracks.length !== tracks.length) {
      throw new Error("歌单包含不安全或格式无效的歌曲");
    }
    const id = uuidv4();
    const playlist = requireSafePlaylist({
      id,
      name,
      coverUrl,
      tracks: persistedTracks.map(withMeta),
      createdAt: Date.now(),
      update_time: Date.now(),
      is_deleted: false,
    });
    set((s) => ({
      playlists: [playlist, ...s.playlists],
    }));
    return id;
  },
  deletePlaylist: (id) =>
    set((s) => ({
      playlists: updateList(s.playlists, id, { is_deleted: true }),
    })),
  restorePlaylist: (id) =>
    set((s) => ({
      playlists: updateList(s.playlists, id, { is_deleted: false }),
    })),
  renamePlaylist: (id, name) =>
    set((s) => {
      assertNoSensitiveData(name);
      return {
        playlists: updateList(s.playlists, id, { name, is_deleted: false }),
      };
    }),
  updatePlaylist: (id, data) => {
    assertNoSensitiveData(data);
    set((s) => ({
      playlists: updateList(s.playlists, id, (playlist) => {
        const tracks =
          data.tracks === undefined ? playlist.tracks : safeTracks(data.tracks);
        if (data.tracks !== undefined && tracks.length !== data.tracks.length) {
          throw new Error("歌单包含不安全或格式无效的歌曲");
        }
        return requireSafePlaylist({
          id: playlist.id,
          name: data.name ?? playlist.name,
          tracks,
          createdAt: playlist.createdAt,
          update_time: playlist.update_time,
          is_deleted: false,
          coverUrl:
            data.coverUrl === undefined ? playlist.coverUrl : data.coverUrl,
          description:
            data.description === undefined
              ? playlist.description
              : data.description,
        });
      }),
    }));
  },
  addToPlaylist: (pid, track) =>
    set((s) => {
      const safeTrack = sanitizeTrackForPersistence(track);
      if (!safeTrack) {
        toastUtils.error("歌曲包含不安全或无效的数据");
        return s;
      }
      if (safeTrack.source === "local") {
        toastUtils.info("本地音乐不支持添加歌单");
        return s;
      }
      return {
        playlists: updateList(s.playlists, pid, (p) => {
          const nextTrack = { ...withMeta(safeTrack), is_deleted: false };
          const exists = p.tracks.some((candidate) =>
            isSameTrackIdentity(candidate, safeTrack)
          );
          return {
            tracks: exists
              ? updateTracksByIdentity(p.tracks, safeTrack, nextTrack)
              : [nextTrack, ...p.tracks],
            is_deleted: false,
          };
        }),
      };
    }),
  removeFromPlaylist: (pid, track) =>
    set((s) => ({
      playlists: updateList(s.playlists, pid, (p) => ({
        tracks: updateOneTrackByIdentity(p.tracks, track, {
          is_deleted: true,
        }),
      })),
    })),
  addBatchToPlaylist: (pid, tracks) =>
    set((s) => {
      const eligible = safeTracks(tracks).filter((t) => t.source !== "local");
      if (!eligible.length) return s;
      return {
        playlists: updateList(s.playlists, pid, (p) => {
          const uniqueEligible = new Map(
            eligible.map((track) => [getTrackIdentityKey(track), track])
          );
          const existingKeys = new Set(
            p.tracks.map((track) => getTrackIdentityKey(track))
          );
          const toAdd = [...uniqueEligible.entries()]
            .filter(([key]) => !existingKeys.has(key))
            .map(([, track]) => ({
              ...withMeta(track),
              is_deleted: false,
            }));
          const updatedTracks = p.tracks.map((track) => {
            const incoming = uniqueEligible.get(getTrackIdentityKey(track));
            return incoming
              ? { ...withMeta(incoming), is_deleted: false }
              : track;
          });
          return {
            tracks: [...toAdd, ...updatedTracks],
            is_deleted: false,
          };
        }),
      };
    }),
  removeBatchFromPlaylist: (pid, tracks) =>
    set((s) => {
      return {
        playlists: updateList(s.playlists, pid, (p) => ({
          tracks: updateTrackOccurrences(p.tracks, tracks, {
            is_deleted: true,
          }),
        })),
      };
    }),
  setPlaylistTracks: (pid, tracks) =>
    set((s) => ({
      playlists: updateList(s.playlists, pid, {
        tracks: safeTracks(tracks).map(withMeta),
        is_deleted: false,
      }),
    })),
  replaceActivePlaylistTracks: (pid, tracks) =>
    set((s) => ({
      playlists: updateList(s.playlists, pid, (p) => ({
        tracks: replaceActiveWithTombstones(p.tracks, safeTracks(tracks)),
        is_deleted: false,
      })),
    })),
  reorderPlaylistTracks: (pid, tracks) =>
    set((s) => ({
      playlists: updateList(s.playlists, pid, (p) => ({
        tracks: mergeActiveWithTombstones(p.tracks, safeTracks(tracks)),
        is_deleted: false,
      })),
    })),
});
