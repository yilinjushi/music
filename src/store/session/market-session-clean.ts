import type { ArtistAlbum, MarketPlaylist } from "@/lib/netease/netease-types";
import {
  containsSensitiveData,
  validateOpaqueMusicIdentifier,
  validatePersistableResourceReference,
} from "@/lib/utils/sensitive-data";

const MAX_TEXT_LENGTH = 512;
const MAX_RESOURCE_LENGTH = 16 * 1024;
const MAX_COLLECTION_ITEMS = 500;
const MAX_SNAPSHOTS = 100;
const MAX_OFFSET = 100_000;
const MAX_SCROLL_TOP = 100_000_000;

export const MARKET_SESSION_VERSION = 2;
export const ARTIST_ALBUM_FLOW_CACHE_VERSION = 2;

export interface CleanMineDataState {
  recommend: MarketPlaylist[] | null;
  created: MarketPlaylist[] | null;
  subscribed: MarketPlaylist[] | null;
  albums: ArtistAlbum[] | null;
  hasMoreAlbums: boolean;
}

export interface CleanListSnapshot {
  items: MarketPlaylist[];
  offset: number;
  hasMore: boolean;
}

export interface CleanSearchCache extends CleanListSnapshot {
  query: string;
}

export interface CleanMarketSessionState {
  mineData: CleanMineDataState;
  listSnapshots: Record<string, CleanListSnapshot>;
  searchCache: CleanSearchCache | null;
}

export interface ArtistAlbumFlowCache {
  version: number;
  albums: ArtistAlbum[];
  offset: number;
  hasMore: boolean;
  scrollTop: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeText(
  value: unknown,
  maxLength = MAX_TEXT_LENGTH
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    !containsSensitiveData(value)
  );
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    isSafeText(value) &&
    value.length > 0 &&
    validateOpaqueMusicIdentifier(value)
  );
}

function isSafeOptionalIdentifier(value: unknown): value is string {
  return isSafeText(value) && validateOpaqueMusicIdentifier(value);
}

function isSafeEntityId(value: unknown): value is string | number {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    isSafeIdentifier(value)
  );
}

function boundedInteger(
  value: unknown,
  fallback: number,
  maximum = MAX_OFFSET
): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : fallback;
}

function safeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

export function sanitizeMarketPlaylist(value: unknown): MarketPlaylist | null {
  if (!isRecord(value) || containsSensitiveData(value)) return null;
  if (
    !isSafeIdentifier(value.id) ||
    !isSafeText(value.name) ||
    !isSafeText(value.coverUrl, MAX_RESOURCE_LENGTH) ||
    !validatePersistableResourceReference(value.coverUrl) ||
    typeof value.playCount !== "number" ||
    !Number.isFinite(value.playCount) ||
    value.playCount < 0 ||
    (value.userId !== undefined && !isSafeOptionalIdentifier(value.userId))
  ) {
    return null;
  }

  const clean: MarketPlaylist = {
    id: value.id,
    name: value.name,
    coverUrl: value.coverUrl,
    playCount: value.playCount,
  };
  if (value.userId !== undefined) clean.userId = value.userId;
  return clean;
}

export function sanitizeMarketPlaylistList(value: unknown): MarketPlaylist[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_COLLECTION_ITEMS).flatMap((item) => {
    const playlist = sanitizeMarketPlaylist(item);
    return playlist ? [playlist] : [];
  });
}

function sanitizeArtistSummary(
  value: unknown
): ArtistAlbum["artist"] | undefined {
  if (!isRecord(value) || !isSafeText(value.name)) return undefined;
  const id = isSafeEntityId(value.id) ? value.id : "";
  const picUrl =
    isSafeText(value.picUrl, MAX_RESOURCE_LENGTH) &&
    validatePersistableResourceReference(value.picUrl)
      ? value.picUrl
      : "";
  const albumSize = boundedInteger(value.albumSize, 0);
  return { id, name: value.name, picUrl, albumSize };
}

export function sanitizeArtistAlbum(value: unknown): ArtistAlbum | null {
  if (!isRecord(value) || containsSensitiveData(value)) return null;
  if (
    !isSafeEntityId(value.id) ||
    !isSafeText(value.name) ||
    !isSafeText(value.picUrl, MAX_RESOURCE_LENGTH) ||
    !validatePersistableResourceReference(value.picUrl) ||
    (value.type !== undefined && !isSafeText(value.type))
  ) {
    return null;
  }

  const clean: ArtistAlbum = {
    id: value.id,
    name: value.name,
    picUrl: value.picUrl,
    publishTime: boundedInteger(value.publishTime, 0, Number.MAX_SAFE_INTEGER),
    size: boundedInteger(value.size, 0),
  };
  if (value.type !== undefined) clean.type = value.type;
  const artist = sanitizeArtistSummary(value.artist);
  if (artist) clean.artist = artist;
  return clean;
}

export function sanitizeArtistAlbumList(value: unknown): ArtistAlbum[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_COLLECTION_ITEMS).flatMap((item) => {
    const album = sanitizeArtistAlbum(item);
    return album ? [album] : [];
  });
}

function nullablePlaylistList(value: unknown): MarketPlaylist[] | null {
  return value === null || value === undefined
    ? null
    : sanitizeMarketPlaylistList(value);
}

function nullableAlbumList(value: unknown): ArtistAlbum[] | null {
  return value === null || value === undefined
    ? null
    : sanitizeArtistAlbumList(value);
}

export function sanitizeMineDataState(value: unknown): CleanMineDataState {
  const candidate = isRecord(value) ? value : {};
  return {
    recommend: nullablePlaylistList(candidate.recommend),
    created: nullablePlaylistList(candidate.created),
    subscribed: nullablePlaylistList(candidate.subscribed),
    albums: nullableAlbumList(candidate.albums),
    hasMoreAlbums: safeBoolean(candidate.hasMoreAlbums, true),
  };
}

function sanitizeListSnapshot(value: unknown): CleanListSnapshot | null {
  if (!isRecord(value) || containsSensitiveData(value)) return null;
  return {
    items: sanitizeMarketPlaylistList(value.items),
    offset: boundedInteger(value.offset, 0),
    hasMore: safeBoolean(value.hasMore, false),
  };
}

function isSafeSnapshotKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_TEXT_LENGTH &&
    !hasControlCharacter(value) &&
    !containsSensitiveData(value)
  );
}

function sanitizeListSnapshots(
  value: unknown
): Record<string, CleanListSnapshot> {
  if (!isRecord(value)) return {};
  const clean: Record<string, CleanListSnapshot> = {};
  for (const [key, rawSnapshot] of Object.entries(value).slice(
    0,
    MAX_SNAPSHOTS
  )) {
    if (!isSafeSnapshotKey(key)) continue;
    const snapshot = sanitizeListSnapshot(rawSnapshot);
    if (snapshot) clean[key] = snapshot;
  }
  return clean;
}

function sanitizeSearchCache(value: unknown): CleanSearchCache | null {
  if (!isRecord(value) || containsSensitiveData(value)) return null;
  const snapshot = sanitizeListSnapshot(value);
  if (
    !snapshot ||
    !isSafeText(value.query, 256) ||
    value.query.trim().length === 0
  ) {
    return null;
  }
  return { query: value.query, ...snapshot };
}

export function sanitizePersistedMarketSessionState(
  value: unknown
): CleanMarketSessionState {
  const candidate = isRecord(value) ? value : {};
  return {
    mineData: sanitizeMineDataState(candidate.mineData),
    listSnapshots: sanitizeListSnapshots(candidate.listSnapshots),
    searchCache: sanitizeSearchCache(candidate.searchCache),
  };
}

export function createEmptyArtistAlbumFlowCache(): ArtistAlbumFlowCache {
  return {
    version: ARTIST_ALBUM_FLOW_CACHE_VERSION,
    albums: [],
    offset: 0,
    hasMore: true,
    scrollTop: 0,
  };
}

export function sanitizeArtistAlbumFlowCache(
  value: unknown
): ArtistAlbumFlowCache {
  if (!isRecord(value) || containsSensitiveData(value)) {
    return createEmptyArtistAlbumFlowCache();
  }
  return {
    version: ARTIST_ALBUM_FLOW_CACHE_VERSION,
    albums: sanitizeArtistAlbumList(value.albums),
    offset: boundedInteger(value.offset, 0),
    hasMore: safeBoolean(value.hasMore, true),
    scrollTop: boundedInteger(value.scrollTop, 0, MAX_SCROLL_TOP),
  };
}
