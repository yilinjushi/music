import type { MusicTrack } from "@/types/music";
import { fetchWithTimeout } from "@/lib/api/config";

const CACHE_PREFIX = "/music-api/cache";
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._~:+/=-]{1,256}$/;

export type AudioCacheJobState = "queued" | "running" | "completed" | "failed";

export interface AudioCacheJobStatus {
  jobId: string;
  state: AudioCacheJobState;
  total: number;
  processed: number;
  cached: number;
  skipped: number;
  failed: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

function opaqueTrackReference(track: MusicTrack): {
  source: string;
  id: string;
  urlId?: string;
} | null {
  if (track.source === "local" || track.source === "url") return null;
  if (!OPAQUE_ID_PATTERN.test(track.id)) return null;
  const urlId = OPAQUE_ID_PATTERN.test(track.url_id) ? track.url_id : undefined;
  return { source: track.source, id: track.id, ...(urlId ? { urlId } : {}) };
}

function isAudioCachePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\/music-api\/cache\/audio\?key=[a-f0-9]{64}$/.test(value)
  );
}

export async function lookupAudioCache(
  track: MusicTrack,
  signal?: AbortSignal
): Promise<string | null> {
  const reference = opaqueTrackReference(track);
  if (!reference) return null;

  try {
    const response = await fetchWithTimeout(
      `${CACHE_PREFIX}/lookup`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reference),
        credentials: "include",
        cache: "no-store",
        signal,
      },
      5_000
    );
    if (response.status === 404 || !response.ok) return null;
    const payload = (await response.json().catch(() => null)) as {
      path?: unknown;
    } | null;
    return isAudioCachePath(payload?.path) ? payload.path : null;
  } catch {
    // Cache availability must never make an otherwise playable provider fail.
    return null;
  }
}

const NETEASE_TRACK_ID_PATTERN = /^\d{1,20}$/;
const requestedTrackCaches = new Set<string>();
let trackCacheDisabled = false;

/**
 * 请求服务端在后台缓存一首网易云歌曲。每个会话每首歌最多请求一次；
 * 未登录、未配置对象存储或被限流时静默停止，绝不影响播放。
 */
export function requestNeteaseTrackCache(track: MusicTrack): void {
  if (trackCacheDisabled) return;
  if (track.source !== "_netease" && track.source !== "netease") return;
  if (!NETEASE_TRACK_ID_PATTERN.test(track.id)) return;
  const artist = track.artist.filter((name) => name.length > 0).slice(0, 16);
  if (!track.name || artist.length === 0) return;
  if (requestedTrackCaches.has(track.id)) return;
  requestedTrackCaches.add(track.id);

  void fetchWithTimeout(
    `${CACHE_PREFIX}/netease-track`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: track.id,
        name: track.name.slice(0, 512),
        artist,
      }),
      credentials: "include",
      cache: "no-store",
    },
    5_000
  )
    .then((response) => {
      if (response.status === 404) trackCacheDisabled = true;
      if (response.status === 401 || response.status === 429) {
        requestedTrackCaches.delete(track.id);
      }
    })
    .catch(() => {
      requestedTrackCaches.delete(track.id);
    });
}

async function readJobResponse(
  response: Response
): Promise<AudioCacheJobStatus> {
  if (!response.ok) {
    throw new Error(`Audio cache request failed: ${response.status}`);
  }
  return (await response.json()) as AudioCacheJobStatus;
}

export async function startNeteasePlaylistCache(
  playlistId: string,
  signal?: AbortSignal
): Promise<AudioCacheJobStatus> {
  const response = await fetchWithTimeout(
    `${CACHE_PREFIX}/netease-playlist`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistId }),
      credentials: "include",
      cache: "no-store",
      signal,
    },
    10_000
  );
  return readJobResponse(response);
}

export async function getAudioCacheJob(
  jobId: string,
  signal?: AbortSignal
): Promise<AudioCacheJobStatus> {
  const response = await fetchWithTimeout(
    `${CACHE_PREFIX}/jobs/${encodeURIComponent(jobId)}`,
    {
      credentials: "include",
      cache: "no-store",
      signal,
    },
    5_000
  );
  return readJobResponse(response);
}

/**
 * Ask the server to run one bounded background sync step for a NetEase
 * playlist (caches the next few songs into object storage). Fire-and-forget.
 */
export function requestNeteasePlaylistSync(playlistId: string): void {
  void fetchWithTimeout(
    `${CACHE_PREFIX}/netease-playlist-sync`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistId }),
      credentials: "include",
      cache: "no-store",
    },
    5_000
  ).catch(() => undefined);
}

/** NetEase song ids the cache sync found no complete source for. */
export async function getUnavailableTrackIds(
  playlistId: string,
  signal?: AbortSignal
): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(
      `${CACHE_PREFIX}/playlist-status?playlistId=${encodeURIComponent(playlistId)}`,
      { credentials: "include", cache: "no-store", signal },
      5_000
    );
    if (!response.ok) return [];
    const payload = (await response.json().catch(() => null)) as {
      unavailable?: unknown;
    } | null;
    return Array.isArray(payload?.unavailable)
      ? payload.unavailable.filter(
          (id): id is string => typeof id === "string" && /^\d{1,20}$/.test(id)
        )
      : [];
  } catch {
    return [];
  }
}

/** Cached song ids of the playlist, newest likes first (null if unknown). */
export async function getOfflineTrackIds(
  playlistId: string
): Promise<string[] | null> {
  try {
    const response = await fetchWithTimeout(
      `${CACHE_PREFIX}/playlist-offline?playlistId=${encodeURIComponent(playlistId)}`,
      { credentials: "include", cache: "no-store" },
      8_000
    );
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as {
      ids?: unknown;
    } | null;
    return Array.isArray(payload?.ids)
      ? payload.ids.filter(
          (id): id is string => typeof id === "string" && /^\d{1,20}$/.test(id)
        )
      : null;
  } catch {
    return null;
  }
}

export interface PlaylistCacheStatus {
  total: number;
  ready: number;
  pending: number;
  unavailable: string[];
  updatedAt: number;
}

/** Latest progress of the background cache sync for a playlist. */
export async function getPlaylistCacheStatus(
  playlistId: string,
  signal?: AbortSignal
): Promise<PlaylistCacheStatus | null> {
  try {
    const response = await fetchWithTimeout(
      `${CACHE_PREFIX}/playlist-status?playlistId=${encodeURIComponent(playlistId)}`,
      { credentials: "include", cache: "no-store", signal },
      5_000
    );
    if (!response.ok) return null;
    const payload = (await response
      .json()
      .catch(() => null)) as Partial<PlaylistCacheStatus> | null;
    if (
      !payload ||
      typeof payload.total !== "number" ||
      typeof payload.ready !== "number"
    ) {
      return null;
    }
    return {
      total: payload.total,
      ready: payload.ready,
      pending: typeof payload.pending === "number" ? payload.pending : 0,
      unavailable: Array.isArray(payload.unavailable)
        ? payload.unavailable.filter(
            (id): id is string =>
              typeof id === "string" && /^\d{1,20}$/.test(id)
          )
        : [],
      updatedAt: typeof payload.updatedAt === "number" ? payload.updatedAt : 0,
    };
  } catch {
    return null;
  }
}
