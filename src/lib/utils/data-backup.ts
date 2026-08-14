import {
  useMusicStore,
  sanitizePersistedMusicSettings,
  type FullScreenBackgroundMode,
} from "@/store/music-store";
import { cleanTrack } from "@/lib/utils/clean-track";
import {
  assertNoSensitiveData,
  containsSensitiveData,
  requireSafePlaylist,
  requireSafeTrack,
} from "@/lib/utils/sensitive-data";
import { withMeta } from "@/store/music-store/shared";
import type {
  MusicTrack,
  Playlist,
  MusicSource,
  SourceConfig,
} from "@/types/music";
import { logger } from "@/lib/logger";

/** 备份数据版本号 */
const CURRENT_VERSION = 1;
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const MAX_BACKUP_PLAYLISTS = 500;
const MAX_BACKUP_TRACKS = 1_000;

function backupFileName(): string {
  return `otter-music-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
}

/** Save a backup through the browser download flow. */
export async function saveBackupFile(json: string): Promise<string> {
  const fileName = backupFileName();

  try {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return fileName;
  } catch (error) {
    logger.error("data-backup", "Save backup file failed", error);
    throw error;
  }
}

/** 备份 JSON 顶层结构 */
interface BackupEnvelope {
  version: number;
  type: "otter-music-backup";
  exportedAt: number;
  data: BackupPayload;
}

/** 备份负载 —— 与 partialize 字段对齐 */
interface BackupPayload {
  favorites: MusicTrack[];
  playlists: Playlist[];
  volume: number;
  isRepeat: boolean;
  isShuffle: boolean;
  quality: string;
  searchSource: MusicSource;
  sourceConfigs: SourceConfig[];
  lastPlaylistCategory: string;
  lastMineTab: "recommend" | "created" | "subscribed" | "albums";
  lastFeaturedTab: string;
  enableAutoMatch: boolean;
  autoMatchFavorites: boolean;
  autoMatchPlaylists: boolean;
  enableProxyFallback: boolean;
  bilibiliKeepOriginalMeta: boolean;
  bilibiliAutoMatchSuffix: string;
  fullScreenBackgroundMode: FullScreenBackgroundMode;
  showSourceBadge: boolean;
  downloadQuality: string;
  embedCover: boolean;
  embedLyric: boolean;
  downloadDirectory: string;
  sleepTimerDuration: number;
  playbackSpeed: number;
}

function buildBackupPayload(
  value: unknown,
  favorites: MusicTrack[],
  playlists: Playlist[]
): BackupPayload {
  const settings = sanitizePersistedMusicSettings(value);
  return {
    favorites,
    playlists,
    volume: settings.volume ?? 1,
    isRepeat: settings.isRepeat ?? false,
    isShuffle: settings.isShuffle ?? false,
    quality: settings.quality ?? "192",
    searchSource: settings.searchSource ?? "all",
    sourceConfigs: settings.sourceConfigs ?? [],
    lastPlaylistCategory: settings.lastPlaylistCategory ?? "全部",
    lastMineTab: settings.lastMineTab ?? "recommend",
    lastFeaturedTab: settings.lastFeaturedTab ?? "",
    enableAutoMatch: settings.enableAutoMatch ?? true,
    autoMatchFavorites: settings.autoMatchFavorites ?? false,
    autoMatchPlaylists: settings.autoMatchPlaylists ?? true,
    enableProxyFallback: settings.enableProxyFallback ?? true,
    bilibiliKeepOriginalMeta: settings.bilibiliKeepOriginalMeta ?? false,
    bilibiliAutoMatchSuffix: settings.bilibiliAutoMatchSuffix ?? "高音质 原曲",
    fullScreenBackgroundMode: settings.fullScreenBackgroundMode ?? "theme",
    showSourceBadge: settings.showSourceBadge ?? false,
    downloadQuality: settings.downloadQuality ?? "320",
    embedCover: settings.embedCover ?? true,
    embedLyric: settings.embedLyric ?? true,
    downloadDirectory: settings.downloadDirectory ?? "",
    sleepTimerDuration: settings.sleepTimerDuration ?? 30,
    playbackSpeed: settings.playbackSpeed ?? 1,
  };
}

/** 校验成功结果 */
export interface ValidBackupResult {
  valid: true;
  data: BackupPayload;
  summary: { favoritesCount: number; playlistsCount: number };
}

/** 校验失败结果 */
export interface InvalidBackupResult {
  valid: false;
  error: string;
}

export type BackupValidationResult = ValidBackupResult | InvalidBackupResult;

/**
 * 过滤软删除项，清洗 track 数据
 */
function filterActive(tracks: MusicTrack[]): MusicTrack[] {
  return tracks.filter((t) => !t.is_deleted).map(cleanTrack);
}

/**
 * 从当前 Store 序列化全部持久化数据为 JSON 字符串
 */
export function serializeStoreData(): string {
  const state = useMusicStore.getState();
  const payload = buildBackupPayload(
    state,
    filterActive(state.favorites),
    state.playlists
      .filter((p) => !p.is_deleted)
      .map((p) =>
        requireSafePlaylist({
          ...p,
          tracks: filterActive(p.tracks),
        })
      )
  );

  const envelope: BackupEnvelope = {
    version: CURRENT_VERSION,
    type: "otter-music-backup",
    exportedAt: Date.now(),
    data: payload,
  };

  return JSON.stringify(envelope, null, 2);
}

/**
 * 校验 MusicTrack 基本结构
 */
function isValidTrack(t: unknown): t is MusicTrack {
  if (typeof t !== "object" || t === null) return false;
  const track = t as Record<string, unknown>;
  return (
    typeof track.id === "string" &&
    typeof track.name === "string" &&
    typeof track.source === "string"
  );
}

/**
 * 校验 Playlist 基本结构
 */
function isValidPlaylist(p: unknown): p is Playlist {
  if (typeof p !== "object" || p === null) return false;
  const pl = p as Record<string, unknown>;
  return (
    typeof pl.id === "string" &&
    typeof pl.name === "string" &&
    Array.isArray(pl.tracks)
  );
}

/**
 * 校验并解析备份 JSON 字符串
 * 成功时返回解析后的数据及预览摘要
 */
export function validateBackupData(raw: string): BackupValidationResult {
  if (!raw || !raw.trim()) {
    return { valid: false, error: "输入内容为空" };
  }
  if (new Blob([raw]).size > MAX_BACKUP_BYTES) {
    return { valid: false, error: "备份文件过大" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, error: "JSON 格式无效，请检查是否包含非法字符" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { valid: false, error: "数据格式不正确，应为 JSON 对象" };
  }

  const envelope = parsed as Record<string, unknown>;
  if (containsSensitiveData(envelope)) {
    return { valid: false, error: "备份包含不安全的敏感数据" };
  }

  // 校验 version
  if (typeof envelope.version !== "number") {
    return { valid: false, error: "缺少或无效的版本号 (version)" };
  }
  if (envelope.version !== CURRENT_VERSION) {
    return {
      valid: false,
      error: `不支持的备份版本 ${envelope.version}，当前仅支持 v${CURRENT_VERSION}`,
    };
  }

  // 校验 type（可选但建议）
  if (envelope.type !== "otter-music-backup") {
    return { valid: false, error: "数据格式不匹配，缺少正确的 type 标识" };
  }

  // 校验 data
  const data = envelope.data;
  if (typeof data !== "object" || data === null) {
    return { valid: false, error: "缺少数据内容 (data)" };
  }

  const payload = data as Record<string, unknown>;

  // 校验 favorites
  const favorites = payload.favorites;
  if (favorites !== undefined && !Array.isArray(favorites)) {
    return { valid: false, error: "收藏数据 (favorites) 格式错误" };
  }

  // 校验 playlists
  const playlists = payload.playlists;
  if (playlists === undefined || !Array.isArray(playlists)) {
    return { valid: false, error: "歌单数据 (playlists) 缺失或格式错误" };
  }
  if (playlists.length > MAX_BACKUP_PLAYLISTS) {
    return { valid: false, error: "歌单数量超过导入上限" };
  }
  for (let i = 0; i < playlists.length; i++) {
    if (!isValidPlaylist(playlists[i])) {
      return {
        valid: false,
        error: `第 ${i + 1} 个歌单数据格式不正确`,
      };
    }
  }

  const favoriteCandidates = Array.isArray(favorites) ? favorites : [];
  const playlistTrackCount = (
    playlists as Array<Record<string, unknown>>
  ).reduce(
    (total, playlist) =>
      total + (Array.isArray(playlist.tracks) ? playlist.tracks.length : 0),
    0
  );
  if (favoriteCandidates.length + playlistTrackCount > MAX_BACKUP_TRACKS) {
    return { valid: false, error: "歌曲数量超过导入上限" };
  }
  if (!favoriteCandidates.every(isValidTrack)) {
    return { valid: false, error: "收藏歌曲数据格式不正确" };
  }

  try {
    const validFavorites = favoriteCandidates.map(requireSafeTrack);
    const validPlaylists = (playlists as unknown[]).map(requireSafePlaylist);

    return {
      valid: true,
      data: buildBackupPayload(payload, validFavorites, validPlaylists),
      summary: {
        favoritesCount: validFavorites.length,
        playlistsCount: validPlaylists.length,
      },
    };
  } catch {
    return { valid: false, error: "备份包含不安全或无效的歌曲数据" };
  }
}

/** 将已经完整验证的备份在一次状态提交中全量替换。 */
export function importStoreData(payload: BackupPayload): void {
  assertNoSensitiveData(payload);
  const safeFavorites = payload.favorites.map(requireSafeTrack);
  const safePlaylists = payload.playlists.map(requireSafePlaylist);
  const safePayload = buildBackupPayload(payload, safeFavorites, safePlaylists);
  const restoredAt = Date.now();
  const restoredFavorites = safeFavorites.map((track) => ({
    ...withMeta(track),
    is_deleted: false,
  }));
  const restoredPlaylists = safePlaylists.map((playlist) =>
    requireSafePlaylist({
      ...playlist,
      tracks: playlist.tracks.map((track) => ({
        ...withMeta(track),
        is_deleted: false,
      })),
      update_time: restoredAt,
      is_deleted: false,
    })
  );

  useMusicStore.setState({
    favorites: restoredFavorites,
    playlists: restoredPlaylists,
    volume: safePayload.volume,
    isRepeat: safePayload.isRepeat,
    isShuffle: safePayload.isShuffle,
    quality: safePayload.quality,
    searchSource: safePayload.searchSource,
    sourceConfigs: safePayload.sourceConfigs,
    lastPlaylistCategory: safePayload.lastPlaylistCategory,
    lastMineTab: safePayload.lastMineTab,
    lastFeaturedTab: safePayload.lastFeaturedTab,
    enableAutoMatch: safePayload.enableAutoMatch,
    autoMatchFavorites: safePayload.autoMatchFavorites,
    autoMatchPlaylists: safePayload.autoMatchPlaylists,
    bilibiliKeepOriginalMeta: safePayload.bilibiliKeepOriginalMeta,
    bilibiliAutoMatchSuffix: safePayload.bilibiliAutoMatchSuffix,
    fullScreenBackgroundMode: safePayload.fullScreenBackgroundMode,
    showSourceBadge: safePayload.showSourceBadge,
    playbackSpeed: safePayload.playbackSpeed,
    downloadQuality: safePayload.downloadQuality,
    embedCover: safePayload.embedCover,
    embedLyric: safePayload.embedLyric,
    downloadDirectory: safePayload.downloadDirectory,
    sleepTimerDuration: safePayload.sleepTimerDuration,
    enableProxyFallback: safePayload.enableProxyFallback,
  });
}
