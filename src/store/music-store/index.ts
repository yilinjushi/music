import { create } from "zustand";
import {
  persist,
  createJSONStorage,
  type PersistStorage,
  type StateStorage,
} from "zustand/middleware";
import { storeKey } from "../store-keys";
import {
  createSanitizingStateStorage,
  idbStorage,
} from "@/lib/storage-adapter";
import {
  containsSensitiveData,
  sanitizePlaylistForPersistence,
  sanitizeTrackList,
} from "@/lib/utils/sensitive-data";
import {
  DEFAULT_SOURCE_CONFIGS,
  type MusicSource,
  type SourceConfig,
} from "@/types/music";

import { createFavoritesSlice } from "./favorites-slice";
import { createPlaylistSlice } from "./playlist-slice";
import { createPlaybackSlice } from "./playback-slice";
import { createSearchSlice } from "./search-slice";
import { createUiSlice } from "./ui-slice";
import { createDownloadSettingsSlice } from "./download-settings-slice";
import { createSleepTimerSlice } from "./sleep-timer-slice";

import type { MusicState } from "./types";

export type { MusicState } from "./types";
export type { FullScreenBackgroundMode } from "./ui-slice";

const QUALITY_VALUES = new Set(["128", "192", "320", "999"]);
const LAST_MINE_TABS = new Set([
  "recommend",
  "created",
  "subscribed",
  "albums",
]);
const BACKGROUND_MODES = new Set(["theme", "cover", "texture"]);
const CONFIGURABLE_SOURCES = new Set<MusicSource>(
  DEFAULT_SOURCE_CONFIGS.map((config) => config.source)
);
const SEARCH_SOURCES = new Set<MusicSource>([
  "all",
  ...DEFAULT_SOURCE_CONFIGS.map((config) => config.source),
]);

function isFiniteInRange(
  value: unknown,
  minimum: number,
  maximum: number
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isSafeText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumLength &&
    !containsSensitiveData(value)
  );
}

function sanitizeSourceConfigs(value: unknown): SourceConfig[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > DEFAULT_SOURCE_CONFIGS.length * 2
  ) {
    return undefined;
  }

  const seen = new Set<MusicSource>();
  const configs: SourceConfig[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      containsSensitiveData(candidate)
    ) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const source = record.source;
    if (
      typeof source !== "string" ||
      !CONFIGURABLE_SOURCES.has(source as MusicSource) ||
      seen.has(source as MusicSource) ||
      typeof record.enabled !== "boolean" ||
      typeof record.visible !== "boolean"
    ) {
      continue;
    }
    seen.add(source as MusicSource);
    configs.push({
      source: source as MusicSource,
      enabled: record.enabled,
      visible: record.visible,
    });
  }
  return configs;
}

/** Explicit allowlist for every non-track value permitted in IndexedDB. */
export function sanitizePersistedMusicSettings(
  persistedState: unknown
): Partial<MusicState> {
  if (typeof persistedState !== "object" || persistedState === null) return {};
  const value = persistedState as Record<string, unknown>;
  const safe: Record<string, unknown> = {};

  if (
    Number.isInteger(value.currentIndex) &&
    isFiniteInRange(value.currentIndex, 0, 1_000_000)
  ) {
    safe.currentIndex = value.currentIndex;
  }
  if (isFiniteInRange(value.volume, 0, 1)) safe.volume = value.volume;
  // The in-song position is intentionally not persisted: the app resumes
  // from the start of the last track, so playback never needs to save.
  if (isFiniteInRange(value.duration, 0, Number.MAX_SAFE_INTEGER)) {
    safe.duration = value.duration;
  }
  if (isSafeText(value.quality, 3) && QUALITY_VALUES.has(value.quality)) {
    safe.quality = value.quality;
  }
  if (
    typeof value.searchSource === "string" &&
    SEARCH_SOURCES.has(value.searchSource as MusicSource)
  ) {
    safe.searchSource = value.searchSource;
  }

  const sourceConfigs = sanitizeSourceConfigs(value.sourceConfigs);
  if (sourceConfigs) safe.sourceConfigs = sourceConfigs;

  if (isSafeText(value.lastPlaylistCategory, 256)) {
    safe.lastPlaylistCategory = value.lastPlaylistCategory;
  }
  if (
    typeof value.lastMineTab === "string" &&
    LAST_MINE_TABS.has(value.lastMineTab)
  ) {
    safe.lastMineTab = value.lastMineTab;
  }
  if (isSafeText(value.lastFeaturedTab, 256)) {
    safe.lastFeaturedTab = value.lastFeaturedTab;
  }
  if (isSafeText(value.bilibiliAutoMatchSuffix, 256)) {
    safe.bilibiliAutoMatchSuffix = value.bilibiliAutoMatchSuffix;
  }
  if (
    typeof value.fullScreenBackgroundMode === "string" &&
    BACKGROUND_MODES.has(value.fullScreenBackgroundMode)
  ) {
    safe.fullScreenBackgroundMode = value.fullScreenBackgroundMode;
  }
  if (
    isSafeText(value.downloadQuality, 3) &&
    QUALITY_VALUES.has(value.downloadQuality)
  ) {
    safe.downloadQuality = value.downloadQuality;
  }
  if (isSafeText(value.downloadDirectory, 4_096)) {
    safe.downloadDirectory = value.downloadDirectory;
  }
  if (isFiniteInRange(value.sleepTimerDuration, 1, 24 * 60)) {
    safe.sleepTimerDuration = value.sleepTimerDuration;
  }
  if (isFiniteInRange(value.playbackSpeed, 0.25, 4)) {
    safe.playbackSpeed = value.playbackSpeed;
  }

  const booleanKeys = [
    "isRepeat",
    "isShuffle",
    "enableAutoMatch",
    "autoMatchFavorites",
    "autoMatchPlaylists",
    "enableProxyFallback",
    "bilibiliKeepOriginalMeta",
    "showSourceBadge",
    "embedCover",
    "embedLyric",
  ] as const;
  for (const key of booleanKeys) {
    if (typeof value[key] === "boolean") safe[key] = value[key];
  }

  return safe as Partial<MusicState>;
}

/** Drop only contaminated/invalid collection members during the one-time migration. */
export function sanitizePersistedMusicState(
  persistedState: unknown
): Partial<MusicState> {
  if (typeof persistedState !== "object" || persistedState === null) return {};
  const persisted = persistedState as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {
    ...sanitizePersistedMusicSettings(persisted),
  };

  sanitized.favorites = sanitizeTrackList(persisted.favorites);
  sanitized.queue = sanitizeTrackList(persisted.queue);
  sanitized.playlists = Array.isArray(persisted.playlists)
    ? persisted.playlists.flatMap((value) => {
        const playlist = sanitizePlaylistForPersistence(value);
        return playlist ? [playlist] : [];
      })
    : [];

  return sanitized as Partial<MusicState>;
}

export const MUSIC_STORE_VERSION = 2;

export function createMusicStateStorage(
  baseStorage: StateStorage
): StateStorage {
  return createSanitizingStateStorage(baseStorage, {
    version: MUSIC_STORE_VERSION,
    sanitize: sanitizePersistedMusicState,
  });
}

const PERSIST_WRITE_DELAY_MS = 5_000;

/**
 * Coalesce persisted writes. Playback updates the store every second; writing
 * (sanitize + serialize + IndexedDB) on each update keeps the phone busy and
 * warm. Only the latest value is written, at most once per delay. Nothing is
 * written while the page is hidden; pending writes are flushed on hide (once),
 * on return to the foreground, and on unload.
 */
export function createThrottledPersistStorage<T>(
  inner: PersistStorage<T>,
  delayMs = PERSIST_WRITE_DELAY_MS
): PersistStorage<T> {
  let pending: {
    name: string;
    value: Parameters<PersistStorage<T>["setItem"]>[1];
  } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const isHidden = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden";

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const next = pending;
    pending = null;
    if (next) return inner.setItem(next.name, next.value);
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => void flush());
    document.addEventListener("visibilitychange", () => void flush());
  }

  return {
    getItem: (name) => inner.getItem(name),
    setItem: (name, value) => {
      pending = { name, value };
      // Never write in the background; the pending value is saved when the
      // page becomes visible again (or on pagehide).
      if (isHidden()) return;
      timer ??= setTimeout(() => void flush(), delayMs);
    },
    removeItem: (name) => {
      if (pending?.name === name) pending = null;
      return inner.removeItem(name);
    },
  };
}

export const useMusicStore = create<MusicState>()(
  persist(
    (...a) => ({
      ...createFavoritesSlice(...a),
      ...createPlaylistSlice(...a),
      ...createPlaybackSlice(...a),
      ...createSearchSlice(...a),
      ...createUiSlice(...a),
      ...createDownloadSettingsSlice(...a),
      ...createSleepTimerSlice(...a),
    }),
    {
      name: storeKey.MusicStore,
      storage: createThrottledPersistStorage(
        createJSONStorage(() => createMusicStateStorage(idbStorage))!
      ),
      version: MUSIC_STORE_VERSION,
      migrate: (persistedState) => sanitizePersistedMusicState(persistedState),
      merge: (persisted, current) => {
        const state = {
          ...current,
          ...sanitizePersistedMusicState(persisted),
        };
        // 合并 sourceConfigs：过滤已移除的音源，追加新增音源
        const validSources = new Set(
          DEFAULT_SOURCE_CONFIGS.map((c) => c.source)
        );
        state.sourceConfigs = Array.isArray(state.sourceConfigs)
          ? state.sourceConfigs.filter(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                validSources.has(c.source)
            )
          : [];
        const existingSources = new Set(
          state.sourceConfigs.map((c) => c.source)
        );
        const newConfigs = DEFAULT_SOURCE_CONFIGS.filter(
          (c) => !existingSources.has(c.source)
        );
        if (newConfigs.length > 0) {
          state.sourceConfigs = [...state.sourceConfigs, ...newConfigs];
        }
        return state;
      },
      partialize: (state) => sanitizePersistedMusicState(state),
    }
  )
);
