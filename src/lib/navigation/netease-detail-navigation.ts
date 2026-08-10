import { containsSensitiveData } from "@/lib/utils/sensitive-data";

export interface ArtistAlbumSheetNavigationState {
  from?: "artist-album-sheet";
  artistId?: string;
  artistName?: string;
  restoreAlbumSheet?: boolean;
}

const LEGACY_SHEET_RESTORE_KEY = "netease-album-sheet-restore";
export const ALBUM_SHEET_RESTORE_SESSION_KEY = "netease-album-sheet-restore:v2";
export const ALBUM_SHEET_RESTORE_SESSION_VERSION = 2;
const MAX_ARTIST_ID_LENGTH = 32;
const MAX_ARTIST_NAME_LENGTH = 256;

export interface AlbumSheetRestoreSession {
  artistId: string;
  artistName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeArtistId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_ARTIST_ID_LENGTH &&
    /^\d+$/.test(value)
  );
}

function isSafeArtistName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_ARTIST_NAME_LENGTH &&
    !containsSensitiveData(value)
  );
}

export function sanitizeAlbumSheetRestoreSession(
  value: unknown
): AlbumSheetRestoreSession | null {
  if (
    !isRecord(value) ||
    value.version !== ALBUM_SHEET_RESTORE_SESSION_VERSION ||
    containsSensitiveData(value) ||
    !isSafeArtistId(value.artistId) ||
    (value.artistName !== undefined && !isSafeArtistName(value.artistName))
  ) {
    return null;
  }

  const clean: AlbumSheetRestoreSession = { artistId: value.artistId };
  if (value.artistName !== undefined) clean.artistName = value.artistName;
  return clean;
}

/** Remove the unversioned fixed-key record before application render. */
export function purgeLegacyAlbumSheetRestoreSession(): void {
  try {
    sessionStorage.removeItem(LEGACY_SHEET_RESTORE_KEY);
  } catch {
    // Session storage may be unavailable in hardened/private contexts.
  }
}

/** 将 sheet 恢复信息写入 sessionStorage，用于 navigate(-1) 回退时恢复 */
export function setAlbumSheetRestoreSession(
  artistId: string,
  artistName?: string
): boolean {
  const clean = sanitizeAlbumSheetRestoreSession({
    version: ALBUM_SHEET_RESTORE_SESSION_VERSION,
    artistId,
    artistName,
  });

  try {
    sessionStorage.removeItem(LEGACY_SHEET_RESTORE_KEY);
    if (!clean) {
      sessionStorage.removeItem(ALBUM_SHEET_RESTORE_SESSION_KEY);
      return false;
    }
    sessionStorage.setItem(
      ALBUM_SHEET_RESTORE_SESSION_KEY,
      JSON.stringify({
        version: ALBUM_SHEET_RESTORE_SESSION_VERSION,
        artistId: clean.artistId,
        ...(clean.artistName === undefined
          ? {}
          : { artistName: clean.artistName }),
      })
    );
    return true;
  } catch {
    return false;
  }
}

/** 读取并清除 sessionStorage 中的 sheet 恢复信息 */
export function consumeAlbumSheetRestoreSession(): AlbumSheetRestoreSession | null {
  try {
    const raw = sessionStorage.getItem(ALBUM_SHEET_RESTORE_SESSION_KEY);
    if (!raw) return null;
    // Consume first: malformed or current-version polluted data can never
    // survive a parse/sanitization failure or be retried on the next route.
    sessionStorage.removeItem(ALBUM_SHEET_RESTORE_SESSION_KEY);
    return sanitizeAlbumSheetRestoreSession(JSON.parse(raw));
  } catch {
    try {
      sessionStorage.removeItem(ALBUM_SHEET_RESTORE_SESSION_KEY);
    } catch {
      // no-op
    }
    return null;
  }
}

export function createArtistAlbumSheetState(
  artistId: string,
  artistName?: string
): ArtistAlbumSheetNavigationState {
  return {
    from: "artist-album-sheet",
    artistId,
    artistName,
    restoreAlbumSheet: true,
  };
}

export function shouldRestoreArtistAlbumSheet(
  type: "playlist" | "artist" | "album",
  currentId: string | null,
  state: ArtistAlbumSheetNavigationState | null | undefined
): boolean {
  return (
    type === "artist" &&
    !!currentId &&
    state?.from === "artist-album-sheet" &&
    state.restoreAlbumSheet === true &&
    state.artistId === currentId
  );
}

export function getArtistAlbumSheetBackTarget(
  type: "playlist" | "artist" | "album",
  state: ArtistAlbumSheetNavigationState | null | undefined
): { artistId: string; artistName?: string } | null {
  if (
    type !== "album" ||
    state?.from !== "artist-album-sheet" ||
    !state.artistId
  ) {
    return null;
  }

  return {
    artistId: state.artistId,
    artistName: state.artistName,
  };
}
