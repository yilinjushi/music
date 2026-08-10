import type { MusicSource, MusicTrack, Playlist } from "@/types/music";
import {
  classifyCanonicalSensitiveAssignments,
  containsCanonicalSensitiveAssignment,
  isCanonicalCapabilityFieldName,
  isCanonicalSensitiveFieldName,
  sensitiveDecodeVariants,
} from "@shared/utils/sensitive-fields";

const MAX_SCAN_DEPTH = 32;
const MAX_SCAN_NODES = 20_000;
const MAX_STRING_LENGTH = 128 * 1024;

const PERSISTABLE_MUSIC_SOURCES = new Set<MusicSource>([
  "netease",
  "_netease",
  "joox",
  "tencent",
  "kugou",
  "kuwo",
  "bilibili",
  "migu",
  "qq",
  "fivesing",
  "tk",
  "wy",
  "kg",
  "kw",
  "mg",
  "qi",
  "lizhi",
  "qingting",
  "ximalaya",
  "xiaoyuzhou",
  "tidal",
  "spotify",
  "ytmusic",
  "qobuz",
  "deezer",
  "all",
  "local",
  "url",
  "lx_kuwo",
  "lx_qq",
]);
const AUDIO_FORMATS = new Set(["mp3", "m4a", "m4s", "flv"]);
const MAX_PERSISTED_STRING_LENGTH = 16 * 1024;
const MAX_ARTISTS = 64;

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_PERSISTED_STRING_LENGTH
  );
}

export function isPersistableMusicSource(value: unknown): value is MusicSource {
  return (
    typeof value === "string" &&
    PERSISTABLE_MUSIC_SOURCES.has(value as MusicSource)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasControlCharacter(value: string): boolean {
  return (
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  );
}

/**
 * Durable resource references must be stable identifiers, not bearer-like URL
 * state. This is deliberately independent of the parameter-name denylist:
 * an unfamiliar query key can still authorize access to a private resource.
 */
function hasNonPersistableUrlState(value: string): boolean {
  return sensitiveDecodeVariants(value).some((variant) => {
    if (variant.includes("?") || variant.includes("#")) return true;

    try {
      const parsed = new URL(variant, "https://same-origin.invalid");
      return Boolean(parsed.username || parsed.password);
    } catch {
      return false;
    }
  });
}

/** Provider identifiers must remain opaque identifiers, never capabilities. */
export function validateOpaqueMusicIdentifier(value: string): boolean {
  if (
    value.length > MAX_PERSISTED_STRING_LENGTH ||
    stringContainsSensitiveAssignment(value)
  ) {
    return false;
  }

  for (const variant of sensitiveDecodeVariants(value)) {
    const candidate = variant.trim();
    if (!candidate) continue;
    if (
      hasControlCharacter(candidate) ||
      /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(candidate) ||
      /^[^\s/:@]+:[^\s/@]+@/.test(candidate)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Reject URLs whose query is an account credential or a short-lived playback
 * capability. Query names are checked separately because an encoded name can
 * otherwise look harmless until URLSearchParams decodes it.
 */
export function urlContainsSensitiveCapability(value: string): boolean {
  const classification = classifyCanonicalSensitiveAssignments(value);
  if (classification.hasCapability || classification.hasCredential) return true;

  try {
    const url = new URL(value, "https://same-origin.invalid");
    for (const [name, child] of url.searchParams) {
      if (
        isCanonicalSensitiveFieldName(name) ||
        isCanonicalCapabilityFieldName(name) ||
        stringContainsSensitiveAssignment(child)
      ) {
        return true;
      }
    }
  } catch {
    // Invalid URLs are rejected by the caller-specific validator.
  }

  return false;
}

/**
 * Covers and lyric references may be opaque provider IDs, public HTTPS URLs,
 * or a same-origin path. Signed/capability URLs, userinfo and fragments never
 * belong in IndexedDB, a backup or a sync snapshot.
 */
export function validatePersistableResourceReference(value: string): boolean {
  if (
    value.length > MAX_PERSISTED_STRING_LENGTH ||
    hasControlCharacter(value) ||
    hasNonPersistableUrlState(value) ||
    urlContainsSensitiveCapability(value)
  ) {
    return false;
  }

  if (!value) return true;
  if (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
  ) {
    try {
      const base = new URL("https://same-origin.invalid");
      const parsed = new URL(value, base);
      return (
        parsed.origin === base.origin &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  }

  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return validateOpaqueMusicIdentifier(value);
  }
}

export function isSensitiveAssignmentName(value: string): boolean {
  return isCanonicalSensitiveFieldName(value);
}

export function stringContainsSensitiveAssignment(value: string): boolean {
  if (value.length > MAX_STRING_LENGTH) return true;
  return containsCanonicalSensitiveAssignment(value);
}

/**
 * Recursively inspect untrusted JSON-like data without serializing it first.
 * Scan limits, cycles, accessors, and non-JSON values are rejected fail-closed.
 */
export function containsSensitiveData(value: unknown): boolean {
  const visiting = new WeakSet<object>();
  let nodes = 0;

  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) return true;

    if (typeof candidate === "string") {
      return stringContainsSensitiveAssignment(candidate);
    }
    if (
      candidate === undefined ||
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "number"
    ) {
      return false;
    }
    if (typeof candidate !== "object") return true;

    if (visiting.has(candidate)) return true;
    visiting.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return candidate.some((item) => visit(item, depth + 1));
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) return true;

      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string") return true;
        if (
          isSensitiveAssignmentName(key) ||
          stringContainsSensitiveAssignment(key)
        ) {
          return true;
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor) return true;
        if (!("value" in descriptor)) return true;
        if (visit(descriptor.value, depth + 1)) return true;
      }

      return false;
    } finally {
      visiting.delete(candidate);
    }
  };

  return visit(value, 0);
}

export function assertNoSensitiveData(value: unknown): void {
  if (containsSensitiveData(value)) {
    throw new Error("输入包含不安全的敏感数据");
  }
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ARTISTS &&
    value.every((item) => isBoundedString(item))
  );
}

export function sanitizeTrackForPersistence(value: unknown): MusicTrack | null {
  if (
    typeof value !== "object" ||
    value === null ||
    containsSensitiveData(value)
  ) {
    return null;
  }

  const track = value as Record<string, unknown>;
  if (
    !isBoundedString(track.id) ||
    !isBoundedString(track.name) ||
    !isStringArray(track.artist) ||
    !isBoundedString(track.album) ||
    !isBoundedString(track.pic_id) ||
    !isBoundedString(track.url_id) ||
    !isBoundedString(track.lyric_id) ||
    !isPersistableMusicSource(track.source)
  ) {
    return null;
  }

  if (
    !validateOpaqueMusicIdentifier(track.id) ||
    !validatePersistableResourceReference(track.pic_id) ||
    !validatePersistableResourceReference(track.lyric_id) ||
    (track.source === "url"
      ? !validatePersistableDirectTrackUrl(track.url_id)
      : !validateOpaqueMusicIdentifier(track.url_id))
  ) {
    return null;
  }

  if (
    (track.update_time !== undefined && !isFiniteNumber(track.update_time)) ||
    (track.is_deleted !== undefined && typeof track.is_deleted !== "boolean") ||
    (track.fee !== undefined && !isFiniteNumber(track.fee)) ||
    (track.artist_ids !== undefined && !isStringArray(track.artist_ids)) ||
    (track.album_id !== undefined && !isBoundedString(track.album_id)) ||
    (track.audioFormat !== undefined &&
      (typeof track.audioFormat !== "string" ||
        !AUDIO_FORMATS.has(track.audioFormat))) ||
    (track.duration !== undefined &&
      (!isFiniteNumber(track.duration) || track.duration < 0))
  ) {
    return null;
  }

  if (
    track.source !== "url" &&
    ((track.album_id !== undefined &&
      !validateOpaqueMusicIdentifier(track.album_id)) ||
      (track.artist_ids !== undefined &&
        !track.artist_ids.every(validateOpaqueMusicIdentifier)))
  ) {
    return null;
  }

  // Explicitly construct the persistence shape. Runtime/provider fields and
  // unknown keys can never silently become part of IndexedDB, backups or sync.
  const persisted: MusicTrack = {
    id: track.id,
    name: track.name,
    artist: [...track.artist],
    album: track.album,
    pic_id: track.pic_id,
    url_id: track.url_id,
    lyric_id: track.lyric_id,
    source: track.source,
  };
  if (track.update_time !== undefined)
    persisted.update_time = track.update_time;
  if (track.is_deleted !== undefined) persisted.is_deleted = track.is_deleted;
  if (track.fee !== undefined) persisted.fee = track.fee;
  if (track.artist_ids !== undefined) {
    persisted.artist_ids = [...track.artist_ids];
  }
  if (track.album_id !== undefined) persisted.album_id = track.album_id;
  if (track.audioFormat !== undefined) {
    persisted.audioFormat = track.audioFormat as MusicTrack["audioFormat"];
  }
  if (track.duration !== undefined) persisted.duration = track.duration;
  return persisted;
}

export function requireSafeTrack(value: unknown): MusicTrack {
  const track = sanitizeTrackForPersistence(value);
  if (!track) throw new Error("歌曲数据不安全或格式无效");
  return track;
}

export function sanitizeTrackList(values: unknown): MusicTrack[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const track = sanitizeTrackForPersistence(value);
    return track ? [track] : [];
  });
}

export function sanitizePlaylistForPersistence(
  value: unknown
): Playlist | null {
  if (typeof value !== "object" || value === null) return null;

  const playlist = value as Record<string, unknown>;
  const { tracks, ...metadataForInspection } = playlist;
  if (
    containsSensitiveData(metadataForInspection) ||
    !isBoundedString(playlist.id) ||
    !validateOpaqueMusicIdentifier(playlist.id) ||
    !isBoundedString(playlist.name) ||
    !Array.isArray(tracks) ||
    (playlist.createdAt !== undefined && !isFiniteNumber(playlist.createdAt)) ||
    (playlist.update_time !== undefined &&
      !isFiniteNumber(playlist.update_time)) ||
    (playlist.is_deleted !== undefined &&
      typeof playlist.is_deleted !== "boolean") ||
    (playlist.coverUrl !== undefined &&
      (!isBoundedString(playlist.coverUrl) ||
        !validatePersistableResourceReference(playlist.coverUrl))) ||
    (playlist.description !== undefined &&
      !isBoundedString(playlist.description))
  ) {
    return null;
  }

  const persisted: Playlist = {
    id: playlist.id,
    name: playlist.name,
    tracks: sanitizeTrackList(tracks),
    createdAt: playlist.createdAt ?? 0,
  };
  if (playlist.update_time !== undefined) {
    persisted.update_time = playlist.update_time;
  }
  if (playlist.is_deleted !== undefined) {
    persisted.is_deleted = playlist.is_deleted;
  }
  if (playlist.coverUrl !== undefined) persisted.coverUrl = playlist.coverUrl;
  if (playlist.description !== undefined) {
    persisted.description = playlist.description;
  }
  return persisted;
}

export function requireSafePlaylist(value: unknown): Playlist {
  assertNoSensitiveData(value);
  const playlist = sanitizePlaylistForPersistence(value);
  if (!playlist) throw new Error("歌单数据不安全或格式无效");
  if (playlist.tracks.length !== (value as Playlist).tracks.length) {
    throw new Error("歌单包含不安全或格式无效的歌曲");
  }
  return playlist;
}

export function validateDirectAudioUrl(value: string): URL | null {
  if (urlContainsSensitiveCapability(value)) return null;

  try {
    const url = new URL(value);
    // A direct URL becomes durable user data. Even an unfamiliar query name
    // can be a bearer capability, so persist only canonical, query-free URLs.
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol === "https:") return url;
  } catch {
    // Invalid URLs are rejected below.
  }

  return null;
}

export function validatePersistableDirectTrackUrl(value: string): boolean {
  if (urlContainsSensitiveCapability(value)) return false;

  if (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
  ) {
    try {
      const base = new URL("https://same-origin.invalid");
      const parsed = new URL(value, base);
      return (
        parsed.origin === base.origin &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  }

  return validateDirectAudioUrl(value) !== null;
}

export function requireSafeDirectAudioUrl(value: string): string {
  const url = validateDirectAudioUrl(value);
  if (!url) throw new Error("仅支持不含敏感参数的 HTTPS 音频链接");
  return url.toString();
}
