import { create } from "zustand";
import {
  persist,
  createJSONStorage,
  type StateStorage,
} from "zustand/middleware";
import { storeKey } from "./store-keys";
import {
  createSanitizingStateStorage,
  idbStorage,
} from "@/lib/storage-adapter";
import type { MusicTrack } from "@/types/music";
import {
  sanitizeTrackForPersistence,
  sanitizeTrackList,
} from "@/lib/utils/sensitive-data";
import {
  isSameTrackIdentity,
  removeOneTrackIdentity,
  type TrackIdentity,
} from "@/lib/utils/track-identity";

const MAX_HISTORY = 100;

interface HistoryState {
  history: MusicTrack[];
  addToHistory: (track: MusicTrack) => void;
  removeFromHistory: (track: TrackIdentity) => void;
  clearHistory: () => void;
}

export function sanitizePersistedHistoryState(
  value: unknown
): Pick<HistoryState, "history"> {
  const persisted = value as { history?: unknown } | null;
  return {
    history: sanitizeTrackList(persisted?.history).slice(0, MAX_HISTORY),
  };
}

export const HISTORY_STORE_VERSION = 2;

export function createHistoryStateStorage(
  baseStorage: StateStorage
): StateStorage {
  return createSanitizingStateStorage(baseStorage, {
    version: HISTORY_STORE_VERSION,
    sanitize: sanitizePersistedHistoryState,
  });
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      history: [],

      addToHistory: (track) =>
        set((state) => {
          const safeTrack = sanitizeTrackForPersistence(track);
          if (!safeTrack) return state;
          const filtered = state.history.filter(
            (candidate) => !isSameTrackIdentity(candidate, safeTrack)
          );
          const newHistory = [safeTrack, ...filtered];
          return { history: newHistory.slice(0, MAX_HISTORY) };
        }),

      removeFromHistory: (track) =>
        set((state) => ({
          history: removeOneTrackIdentity(state.history, track),
        })),

      clearHistory: () => set({ history: [] }),
    }),
    {
      name: storeKey.HistoryStore,
      storage: createJSONStorage(() => createHistoryStateStorage(idbStorage)),
      version: HISTORY_STORE_VERSION,
      migrate: sanitizePersistedHistoryState,
      merge: (persisted, current) => ({
        ...current,
        ...sanitizePersistedHistoryState(persisted),
      }),
      partialize: (state) => ({
        history: sanitizeTrackList(state.history).slice(0, MAX_HISTORY),
      }),
    }
  )
);
