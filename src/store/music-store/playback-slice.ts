import type { StateCreator } from "zustand";
import type { MusicState } from "./types";
import type { MusicSource, MusicTrack } from "@/types/music";
import { clamp, safeTracks, shuffleArray, withMeta } from "./shared";
import { sanitizeTrackForPersistence } from "@/lib/utils/sensitive-data";
import { normalizeAudioUrlForPlayback } from "@/lib/utils/audio-url";
import { toastUtils } from "@/lib/utils/toast";
import {
  findTrackIdentityIndex,
  getTrackIdentityKey,
  isSameTrackIdentity,
  removeOneTrackIdentity,
  trackIdentityFromParts,
  type TrackIdentity,
} from "@/lib/utils/track-identity";

export interface TrackIdentityTuple {
  id: string;
  source: MusicSource;
  urlId: string | undefined;
}

export interface IndexedTrackOwner extends TrackIdentityTuple {
  index: number;
}

export interface PlaylistTrackOwner extends TrackIdentityTuple {
  playlistId: string;
  playlistIndex: number;
  trackIndex: number;
}

export interface MatchedTrackOwners {
  /**
   * Monotonic incarnation of the active playback context. Identity tuples can
   * repeat after A -> B -> A, but an in-flight owner may never reuse an older
   * incarnation.
   */
  contextEpoch: number;
  queue?: IndexedTrackOwner;
  originalQueue?: IndexedTrackOwner;
  favorite?: IndexedTrackOwner;
  playlist?: PlaylistTrackOwner;
}

let playbackContextEpochSequence = 0;

function nextPlaybackContextEpoch(current: number): number {
  playbackContextEpochSequence =
    Math.max(playbackContextEpochSequence, current) + 1;
  return playbackContextEpochSequence;
}

function beginPlaybackContext(state: MusicState) {
  return {
    playbackContextEpoch: nextPlaybackContextEpoch(state.playbackContextEpoch),
    autoMatchContext: null,
  };
}

export function trackMatchesIdentity(
  track: MusicTrack | undefined,
  identity: TrackIdentityTuple
): boolean {
  return isSameTrackIdentity(
    track,
    trackIdentityFromParts(identity.id, identity.source, identity.urlId)
  );
}

// --- Queue Helper ---
function insertNext(
  state: MusicState,
  track: MusicTrack,
  playImmediately: boolean
): Partial<MusicState> {
  const safeTrack = sanitizeTrackForPersistence(track);
  if (!safeTrack) return {};
  track = safeTrack;
  if (!state.queue.length)
    return {
      queue: [track],
      originalQueue: state.isShuffle ? [track] : [],
      currentIndex: 0,
      ...(playImmediately && { currentAudioTime: 0 }),
    };

  const q = [...state.queue];
  const existIdx = findTrackIdentityIndex(q, track);
  if (existIdx === state.currentIndex)
    return playImmediately ? { currentAudioTime: 0 } : {};

  let targetIdx = state.currentIndex + 1;
  let curIdx = state.currentIndex;

  if (existIdx !== -1) {
    q.splice(existIdx, 1);
    if (existIdx < state.currentIndex) {
      targetIdx--;
      curIdx--;
    }
  }
  q.splice(targetIdx, 0, track);

  let oq = state.originalQueue;
  if (state.isShuffle) {
    oq = [...(state.originalQueue || [])];
    const currentTrack = state.queue[state.currentIndex];
    const oqExistIdx = findTrackIdentityIndex(oq, track);
    if (oqExistIdx !== -1) oq.splice(oqExistIdx, 1);
    const oqCurIdx = currentTrack
      ? findTrackIdentityIndex(oq, currentTrack)
      : -1;
    oq.splice(oqCurIdx !== -1 ? oqCurIdx + 1 : oq.length, 0, track);
  }

  return {
    queue: q,
    originalQueue: oq,
    currentIndex: playImmediately ? targetIdx : curIdx,
    ...(playImmediately && { currentAudioTime: 0 }),
  };
}

export interface PlaybackSlice {
  volume: number;
  isRepeat: boolean;
  isShuffle: boolean;
  currentAudioTime: number;
  isPlaying: boolean;
  isLoading: boolean;
  seekTimestamp: number;
  seekTargetTime: number;
  duration: number;
  currentAudioUrl: string | null;
  hasUserGesture: boolean;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  urlRecoveryKey: number;
  incrementUrlRecoveryKey: () => void;
  setVolume: (volume: number) => void;
  toggleRepeat: () => void;
  toggleShuffle: () => void;
  setAudioCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  togglePlay: () => void;
  setIsLoading: (isLoading: boolean) => void;
  seek: (time: number) => void;
  clearSeekTargetTime: () => void;
  setCurrentAudioUrl: (url: string | null) => void;
  setUserGesture: () => void;
  incrementFailures: () => number;
  resetFailures: () => void;
  coverUrl: string | null;
  setCoverUrl: (url: string | null) => void;

  queue: MusicTrack[];
  originalQueue: MusicTrack[];
  currentIndex: number;
  playbackContextEpoch: number;
  contextId: string | null;
  playContext: (
    tracks: MusicTrack[],
    startIndex?: number,
    contextId?: string
  ) => void;
  addToNextPlay: (track: MusicTrack) => void;
  playTrackAsNext: (track: MusicTrack) => void;
  addBatchToNextPlay: (tracks: MusicTrack[]) => void;
  skipToNext: () => void;
  removeFromQueue: (track: TrackIdentity) => void;
  clearQueue: () => void;
  reshuffle: () => void;
  setCurrentIndex: (index: number, resetTime?: boolean) => void;
  setCurrentIndexAndPlay: (index: number) => void;
  /**
   * Replace every explicitly-owned match location in one synchronous CAS.
   * Every index and old identity must still match or no location is changed.
   */
  compareAndSwapMatchedTrack: (
    owners: MatchedTrackOwners,
    newTrack: MusicTrack,
    nextAutoMatchTried?: Set<MusicSource>
  ) => boolean;
}

export const createPlaybackSlice: StateCreator<
  MusicState,
  [],
  [],
  PlaybackSlice
> = (set, get) => ({
  volume: 1.0,
  isRepeat: false,
  isShuffle: false,
  currentAudioTime: 0,
  isPlaying: false,
  isLoading: false,
  seekTimestamp: 0,
  seekTargetTime: -1,
  duration: 0,
  currentAudioUrl: null,
  hasUserGesture: false,
  consecutiveFailures: 0,
  maxConsecutiveFailures: 3,
  urlRecoveryKey: 0,
  coverUrl: null,
  setVolume: (volume) => set({ volume }),
  toggleRepeat: () => set((s) => ({ isRepeat: !s.isRepeat })),
  setAudioCurrentTime: (currentAudioTime) => set({ currentAudioTime }),
  setDuration: (duration) => set({ duration }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  togglePlay: () =>
    set((s) => ({ hasUserGesture: true, isPlaying: !s.isPlaying })),
  setIsLoading: (isLoading) => set({ isLoading }),
  seek: (time) =>
    set({
      seekTargetTime: time,
      seekTimestamp: Date.now(),
      isPlaying: true,
      hasUserGesture: true,
    }),
  clearSeekTargetTime: () => set({ seekTargetTime: -1 }),
  setCurrentAudioUrl: (currentAudioUrl) =>
    set({
      currentAudioUrl:
        currentAudioUrl === null
          ? null
          : normalizeAudioUrlForPlayback(currentAudioUrl),
    }),
  setUserGesture: () => set({ hasUserGesture: true }),
  resetFailures: () => set({ consecutiveFailures: 0 }),
  setCoverUrl: (coverUrl) => set({ coverUrl }),
  incrementUrlRecoveryKey: () =>
    set((s) => ({ urlRecoveryKey: s.urlRecoveryKey + 1 })),
  incrementFailures: () => {
    const f = get().consecutiveFailures + 1;
    set({ consecutiveFailures: f });
    return f;
  },

  // --- Queue Management ---
  queue: [],
  originalQueue: [],
  currentIndex: 0,
  playbackContextEpoch: 0,
  contextId: null,

  toggleShuffle: () =>
    set((s) => {
      const curIdx = clamp(s.currentIndex, Math.max(0, s.queue.length - 1));
      if (!s.isShuffle) {
        if (s.queue.length <= 1)
          return {
            isShuffle: true,
            originalQueue: s.queue,
            ...(s.queue.length ? beginPlaybackContext(s) : {}),
          };
        const curTrack = s.queue[curIdx];
        const rest = s.queue.filter((_, i) => i !== curIdx);
        return {
          isShuffle: true,
          originalQueue: s.queue,
          queue: [curTrack, ...shuffleArray(rest)],
          currentIndex: 0,
          ...beginPlaybackContext(s),
        };
      }
      const currentTrack = s.queue[curIdx];
      const newIdx = currentTrack
        ? findTrackIdentityIndex(s.originalQueue, currentTrack)
        : -1;
      return {
        isShuffle: false,
        queue: s.originalQueue.length ? s.originalQueue : s.queue,
        currentIndex: Math.max(0, newIdx),
        originalQueue: [],
        ...beginPlaybackContext(s),
      };
    }),

  playContext: (tracks, startIdx = 0, contextId) =>
    set((s) => {
      const requestedIndex = tracks.length
        ? clamp(startIdx, tracks.length - 1)
        : 0;
      const sanitizedTracks: MusicTrack[] = [];
      let sanitizedStartIndex = -1;
      for (let index = 0; index < tracks.length; index += 1) {
        const safeTrack = sanitizeTrackForPersistence(tracks[index]);
        if (!safeTrack) continue;
        if (index === requestedIndex) {
          sanitizedStartIndex = sanitizedTracks.length;
        }
        sanitizedTracks.push(safeTrack);
      }
      if (tracks.length && sanitizedStartIndex < 0) {
        toastUtils.error("所选歌曲包含不安全或无效的数据");
        return {};
      }
      tracks = sanitizedTracks;
      startIdx = Math.max(0, sanitizedStartIndex);
      if (!tracks.length)
        return {
          queue: [],
          originalQueue: [],
          currentIndex: 0,
          currentAudioTime: 0,
          isPlaying: false,
          contextId: null,
          ...beginPlaybackContext(s),
        };
      const idx = clamp(startIdx, tracks.length - 1);
      if (s.isShuffle) {
        if (contextId && s.contextId === contextId && startIdx !== undefined) {
          const targetIdx = findTrackIdentityIndex(s.queue, tracks[startIdx]);
          if (targetIdx !== -1)
            return {
              currentIndex: targetIdx,
              currentAudioTime: 0,
              hasUserGesture: true,
              isPlaying: true,
              ...beginPlaybackContext(s),
            };
        }
        const realIdx =
          startIdx !== undefined
            ? idx
            : Math.floor(Math.random() * tracks.length);
        const rest = shuffleArray(tracks.filter((_, i) => i !== realIdx));
        return {
          queue: [tracks[realIdx], ...rest],
          originalQueue: tracks,
          currentIndex: 0,
          currentAudioTime: 0,
          hasUserGesture: true,
          isPlaying: true,
          contextId: contextId ?? null,
          ...beginPlaybackContext(s),
        };
      }
      return {
        queue: tracks,
        originalQueue: tracks,
        currentIndex: idx,
        currentAudioTime: 0,
        hasUserGesture: true,
        isPlaying: true,
        contextId: contextId ?? null,
        ...beginPlaybackContext(s),
      };
    }),

  addBatchToNextPlay: (tracks) =>
    set((s) => {
      tracks = safeTracks(tracks);
      if (!tracks.length) return s;
      if (!s.queue.length) {
        return {
          queue: [...tracks],
          originalQueue: s.isShuffle ? [...tracks] : [],
          currentIndex: 0,
          ...beginPlaybackContext(s),
        };
      }
      let state = s as MusicState;
      for (const track of [...tracks].reverse()) {
        state = {
          ...state,
          ...insertNext(state, track, false),
        } as MusicState;
      }
      const next = {
        queue: state.queue,
        originalQueue: state.originalQueue,
        currentIndex: state.currentIndex,
      };
      return state.currentIndex !== s.currentIndex
        ? { ...next, ...beginPlaybackContext(s) }
        : next;
    }),

  addToNextPlay: (track) =>
    set((s) => {
      const next = insertNext(s, track, false);
      const changesActiveOwner =
        !s.queue.length ||
        (typeof next.currentIndex === "number" &&
          next.currentIndex !== s.currentIndex);
      return changesActiveOwner && Object.keys(next).length
        ? { ...next, ...beginPlaybackContext(s) }
        : next;
    }),
  playTrackAsNext: (track) =>
    set((s) => {
      const next = insertNext(s, track, true);
      return Object.keys(next).length
        ? { ...next, ...beginPlaybackContext(s) }
        : next;
    }),

  removeFromQueue: (track) =>
    set((s) => {
      const idx = findTrackIdentityIndex(s.queue, track);
      if (idx === -1) return {};
      const queueTrack = s.queue[idx];
      const q = removeOneTrackIdentity(s.queue, queueTrack);
      if (!q.length)
        return {
          queue: [],
          originalQueue: [],
          currentIndex: 0,
          currentAudioTime: 0,
          isPlaying: false,
          ...beginPlaybackContext(s),
        };
      const next = {
        queue: q,
        originalQueue: s.isShuffle
          ? removeOneTrackIdentity(s.originalQueue || [], queueTrack)
          : s.originalQueue,
        currentIndex:
          idx < s.currentIndex
            ? s.currentIndex - 1
            : Math.min(s.currentIndex, q.length - 1),
      };
      return idx <= s.currentIndex
        ? { ...next, ...beginPlaybackContext(s) }
        : next;
    }),

  clearQueue: () =>
    set((s) => ({
      queue: [],
      originalQueue: [],
      currentIndex: 0,
      currentAudioTime: 0,
      isPlaying: false,
      duration: 0,
      contextId: null,
      ...(s.queue.length ? beginPlaybackContext(s) : {}),
    })),
  reshuffle: () =>
    set((s) =>
      s.isShuffle && s.queue.length > 1
        ? (() => {
            const currentTrack = s.queue[s.currentIndex];
            const sourceQueue = s.originalQueue?.length
              ? s.originalQueue
              : s.queue;
            return {
              queue: [
                currentTrack,
                ...shuffleArray(
                  removeOneTrackIdentity(sourceQueue, currentTrack)
                ),
              ],
              currentIndex: 0,
              ...beginPlaybackContext(s),
            };
          })()
        : {}
    ),

  setCurrentIndex: (idx, resetTime = true) =>
    set((s) => ({
      currentIndex: s.queue.length ? clamp(idx, s.queue.length - 1) : 0,
      currentAudioTime: resetTime ? 0 : s.currentAudioTime,
      ...beginPlaybackContext(s),
    })),
  setCurrentIndexAndPlay: (idx) =>
    set((s) => ({
      currentIndex: s.queue.length ? clamp(idx, s.queue.length - 1) : 0,
      currentAudioTime: 0,
      hasUserGesture: true,
      isPlaying: true,
      ...beginPlaybackContext(s),
    })),
  skipToNext: () =>
    set((s) =>
      s.queue.length
        ? {
            currentIndex: (s.currentIndex + 1) % s.queue.length,
            currentAudioTime: 0,
            ...beginPlaybackContext(s),
          }
        : {}
    ),

  compareAndSwapMatchedTrack: (owners, newTrack, nextAutoMatchTried) => {
    const safeTrack = sanitizeTrackForPersistence(newTrack);
    if (!safeTrack) return false;

    let committed = false;
    set((s) => {
      const hasOwner = Boolean(
        owners.queue ||
        owners.originalQueue ||
        owners.favorite ||
        owners.playlist
      );
      if (!hasOwner) return {};
      if (s.playbackContextEpoch !== owners.contextEpoch) return {};
      if (
        owners.queue &&
        (s.currentIndex !== owners.queue.index ||
          !trackMatchesIdentity(s.queue[owners.queue.index], owners.queue))
      ) {
        return {};
      }
      if (
        owners.originalQueue &&
        !trackMatchesIdentity(
          s.originalQueue[owners.originalQueue.index],
          owners.originalQueue
        )
      ) {
        return {};
      }
      if (
        owners.favorite &&
        (s.favorites[owners.favorite.index]?.is_deleted ||
          !trackMatchesIdentity(
            s.favorites[owners.favorite.index],
            owners.favorite
          ))
      ) {
        return {};
      }
      if (owners.playlist) {
        const playlist = s.playlists[owners.playlist.playlistIndex];
        const playlistTrack = playlist?.tracks[owners.playlist.trackIndex];
        if (
          playlist?.id !== owners.playlist.playlistId ||
          playlistTrack?.is_deleted ||
          !trackMatchesIdentity(playlistTrack, owners.playlist)
        ) {
          return {};
        }
      }

      const replaceAt = (
        tracks: MusicTrack[],
        index: number,
        replacement: MusicTrack
      ) =>
        tracks.map((item, itemIndex) =>
          itemIndex === index ? replacement : item
        );
      const persistedReplacement = {
        ...withMeta(safeTrack),
        is_deleted: false,
      };
      const nextContext = owners.queue ? beginPlaybackContext(s) : null;
      const next: Partial<MusicState> = nextContext ? { ...nextContext } : {};

      if (owners.queue) {
        next.queue = replaceAt(s.queue, owners.queue.index, safeTrack);
        if (owners.queue.index === s.currentIndex) {
          next.currentAudioUrl = null;
        }
      }
      if (owners.originalQueue) {
        next.originalQueue = replaceAt(
          s.originalQueue,
          owners.originalQueue.index,
          safeTrack
        );
      }
      if (owners.favorite) {
        next.favorites = replaceAt(
          s.favorites,
          owners.favorite.index,
          persistedReplacement
        );
      }
      if (owners.playlist) {
        const now = Date.now();
        next.playlists = s.playlists.map((playlist, playlistIndex) =>
          playlistIndex === owners.playlist!.playlistIndex
            ? {
                ...playlist,
                update_time: now,
                tracks: replaceAt(
                  playlist.tracks,
                  owners.playlist!.trackIndex,
                  persistedReplacement
                ),
              }
            : playlist
        );
      }
      if (nextAutoMatchTried !== undefined && owners.queue && nextContext) {
        next.autoMatchContext = {
          index: owners.queue.index,
          contextEpoch: nextContext.playbackContextEpoch,
          trackKey: getTrackIdentityKey(safeTrack),
          tried: new Set(nextAutoMatchTried),
        };
      }
      committed = true;
      return next;
    });
    return committed;
  },
});
