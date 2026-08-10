import {
  createEmptyArtistAlbumFlowCache,
  sanitizeArtistAlbumFlowCache,
  type ArtistAlbumFlowCache,
} from "./market-session-clean";

const SESSION_PREFIX = "artist-album-flow:";

interface SynchronousStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
}

export function createArtistAlbumFlowCacheKey(
  artistId: string | null
): string | null {
  return artistId && /^\d{1,32}$/.test(artistId)
    ? `${SESSION_PREFIX}${artistId}`
    : null;
}

export function readArtistAlbumFlowCache(
  storage: SynchronousStorage,
  key: string
): ArtistAlbumFlowCache {
  try {
    const raw = storage.getItem(key);
    const clean = sanitizeArtistAlbumFlowCache(raw ? JSON.parse(raw) : null);
    const serialized = JSON.stringify(clean);
    if (raw !== serialized) storage.setItem(key, serialized);
    return clean;
  } catch {
    const clean = createEmptyArtistAlbumFlowCache();
    storage.setItem(key, JSON.stringify(clean));
    return clean;
  }
}

export function writeArtistAlbumFlowCache(
  storage: Pick<SynchronousStorage, "setItem">,
  key: string,
  value: unknown
): ArtistAlbumFlowCache {
  const clean = sanitizeArtistAlbumFlowCache(value);
  storage.setItem(key, JSON.stringify(clean));
  return clean;
}
