import type { MusicTrack } from "@/types/music";
import { fetchWithTimeout } from "@/lib/api/config";

const CACHE_PREFIX = "/music-api/cache";
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._~:+/=-]{1,256}$/;

export type AudioCacheJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed";

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
