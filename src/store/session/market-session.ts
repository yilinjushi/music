import { create } from "zustand";
import {
  persist,
  createJSONStorage,
  type StateStorage,
} from "zustand/middleware";
import type { MarketPlaylist, ArtistAlbum } from "@/lib/netease/netease-types";
import { createSanitizingStateStorage } from "@/lib/storage-adapter";
import { storeKey } from "@/store/store-keys";
import {
  MARKET_SESSION_VERSION,
  sanitizeArtistAlbum,
  sanitizeArtistAlbumList,
  sanitizeMarketPlaylist,
  sanitizeMarketPlaylistList,
  sanitizeMineDataState,
  sanitizePersistedMarketSessionState,
  type CleanMarketSessionState,
} from "./market-session-clean";

// 抽离初始状态，便于 clearSession 复用
const createInitialMineData = (): MineDataState => ({
  recommend: null,
  created: null,
  subscribed: null,
  albums: null,
  hasMoreAlbums: true,
});

export interface MineDataState {
  recommend: MarketPlaylist[] | null;
  created: MarketPlaylist[] | null;
  subscribed: MarketPlaylist[] | null;
  albums: ArtistAlbum[] | null;
  hasMoreAlbums: boolean;
}

export interface ListSnapshot {
  items: MarketPlaylist[];
  offset: number;
  hasMore: boolean;
}

export interface SearchCache {
  query: string;
  items: MarketPlaylist[];
  offset: number;
  hasMore: boolean;
}

export function createMarketSessionStateStorage(
  baseStorage: StateStorage
): StateStorage {
  return createSanitizingStateStorage(baseStorage, {
    version: MARKET_SESSION_VERSION,
    sanitize: sanitizePersistedMarketSessionState,
  });
}

interface MarketSessionState {
  mineData: MineDataState;
  listSnapshots: Record<string, ListSnapshot>;
  searchCache: SearchCache | null;
  setMineData: (
    data: Partial<MineDataState> | ((prev: MineDataState) => MineDataState)
  ) => void;
  saveListSnapshot: (key: string, snapshot: ListSnapshot) => void;
  saveSearchCache: (cache: SearchCache | null) => void;
  toggleAlbumInSession: (
    album: {
      id: string | number;
      name: string;
      picUrl: string;
      artistName?: string;
    },
    isSub: boolean
  ) => void;
  togglePlaylistInSession: (
    playlist: MarketPlaylist,
    shouldSub: boolean
  ) => void;
  clearSession: () => void;
}

export const useMarketSession = create<MarketSessionState>()(
  persist<MarketSessionState, [], [], CleanMarketSessionState>(
    (set) => ({
      mineData: createInitialMineData(),
      listSnapshots: {},
      searchCache: null,

      setMineData: (data) =>
        set((state) => {
          const current = sanitizeMineDataState(state.mineData);
          const next =
            typeof data === "function"
              ? data(current)
              : { ...current, ...data };
          return { mineData: sanitizeMineDataState(next) };
        }),

      saveListSnapshot: (key, snapshot) =>
        set((state) => {
          const existing =
            sanitizePersistedMarketSessionState(state).listSnapshots;
          const clean = sanitizePersistedMarketSessionState({
            listSnapshots: { [key]: snapshot },
          }).listSnapshots[key];
          if (!clean) return { listSnapshots: existing };
          return {
            listSnapshots: { ...existing, [key]: clean },
          };
        }),

      saveSearchCache: (cache) =>
        set({
          searchCache: sanitizePersistedMarketSessionState({
            searchCache: cache,
          }).searchCache,
        }),

      toggleAlbumInSession: (album, shouldSub) =>
        set((state) => {
          const cleanMineData = sanitizeMineDataState(state.mineData);
          const { albums } = cleanMineData;
          if (!albums) return { mineData: cleanMineData };

          const safeAlbum = sanitizeArtistAlbum({
            id: album.id,
            name: album.name,
            picUrl: album.picUrl,
            publishTime: 0,
            size: 0,
            artist: { name: album.artistName || "" },
          });
          if (!safeAlbum) return { mineData: cleanMineData };

          const newAlbums = shouldSub
            ? [safeAlbum, ...sanitizeArtistAlbumList(albums)]
            : sanitizeArtistAlbumList(albums).filter(
                (item) => String(item.id) !== String(album.id)
              );

          return {
            mineData: { ...cleanMineData, albums: newAlbums },
          };
        }),

      togglePlaylistInSession: (playlist, shouldSub) =>
        set((state) => {
          const cleanMineData = sanitizeMineDataState(state.mineData);
          const { subscribed } = cleanMineData;
          if (!subscribed) return { mineData: cleanMineData };

          const safePlaylist = sanitizeMarketPlaylist(playlist);
          if (!safePlaylist) return { mineData: cleanMineData };

          const newSubscribed = shouldSub
            ? [safePlaylist, ...sanitizeMarketPlaylistList(subscribed)]
            : sanitizeMarketPlaylistList(subscribed).filter(
                (item) => String(item.id) !== String(safePlaylist.id)
              );

          return {
            mineData: { ...cleanMineData, subscribed: newSubscribed },
          };
        }),

      clearSession: () =>
        set({
          mineData: createInitialMineData(),
          listSnapshots: {},
          searchCache: null,
        }),
    }),
    {
      name: storeKey.MarketSessionStore,
      storage: createJSONStorage(() =>
        createMarketSessionStateStorage(sessionStorage)
      ),
      version: MARKET_SESSION_VERSION,
      migrate: sanitizePersistedMarketSessionState,
      merge: (persisted, current) => ({
        ...current,
        ...sanitizePersistedMarketSessionState(persisted),
      }),
      partialize: sanitizePersistedMarketSessionState,
    }
  )
);

/**
 * Clear account-derived market data from both the live store and the backing
 * session entry. Authentication teardown awaits this boundary before it is
 * allowed to settle, so a later rehydrate cannot resurrect the previous
 * account's playlists or albums.
 */
export async function clearMarketSession(): Promise<void> {
  useMarketSession.getState().clearSession();
  try {
    sessionStorage.removeItem(storeKey.MarketSessionStore);
  } catch {
    // sessionStorage may be unavailable in private browsing or SSR tests.
  }
}
