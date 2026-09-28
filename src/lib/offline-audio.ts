import type { MusicTrack } from "@/types/music";

/**
 * Offline copies of the owner's cached 红心 songs, kept in Cache Storage on
 * the phone. The server already stores each song in R2 under an opaque key
 * (sha256 of "netease:<id>"), so the phone downloads the same file once and
 * plays it from disk afterwards: instant start, no network, no cost.
 */
const OFFLINE_CACHE = "offline-audio-v1";
const AUDIO_PATH = "/music-api/cache/audio?key=";
const MAX_LIVE_BLOB_URLS = 4;

const liveBlobUrls = new Map<string, string>();

function isOfflineCapable(): boolean {
  return typeof caches !== "undefined" && !!crypto?.subtle;
}

function neteaseId(track: Pick<MusicTrack, "id" | "source">): string | null {
  if (track.source !== "netease" && track.source !== "_netease") return null;
  const id = String(track.id).replace(/^(?:netrack_|ne_track_)/, "");
  return /^\d{1,20}$/.test(id) ? id : null;
}

async function audioPath(songId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`netease:${songId}`)
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${AUDIO_PATH}${hex}`;
}

/** A blob: URL for the song if it is stored on this phone, else null. */
export async function getOfflineAudioUrl(
  track: Pick<MusicTrack, "id" | "source">
): Promise<string | null> {
  const songId = neteaseId(track);
  if (!songId || !isOfflineCapable()) return null;
  const existing = liveBlobUrls.get(songId);
  if (existing) return existing;
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const response = await cache.match(await audioPath(songId));
    if (!response) return null;
    const blob = await response.blob();
    if (blob.size === 0) return null;
    const url = URL.createObjectURL(
      blob.type ? blob : new Blob([blob], { type: "audio/mpeg" })
    );
    liveBlobUrls.set(songId, url);
    // Keep only the current and preloaded songs' blobs alive.
    while (liveBlobUrls.size > MAX_LIVE_BLOB_URLS) {
      const [oldId, oldUrl] = liveBlobUrls.entries().next().value!;
      liveBlobUrls.delete(oldId);
      URL.revokeObjectURL(oldUrl);
    }
    return url;
  } catch {
    return null;
  }
}

export interface OfflineSyncProgress {
  /** songs that should be on the phone */
  total: number;
  /** songs already on the phone */
  stored: number;
  /** a download is running */
  running: boolean;
}

export interface OfflineUsage {
  usedBytes: number;
  quotaBytes: number;
}

export async function getOfflineUsage(): Promise<OfflineUsage | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate) return null;
    return {
      usedBytes: estimate.usage ?? 0,
      quotaBytes: estimate.quota ?? 0,
    };
  } catch {
    return null;
  }
}

let activeSync: Promise<void> | null = null;

/**
 * Make the phone hold exactly `songIds` (newest first): delete songs no longer
 * wanted, then download missing ones one at a time so playback keeps the
 * network. Only one sync runs at a time.
 */
export function syncOfflineAudio(
  songIds: string[],
  onProgress: (progress: OfflineSyncProgress) => void
): Promise<void> {
  if (activeSync || !isOfflineCapable()) return activeSync ?? Promise.resolve();
  activeSync = runSync(songIds, onProgress).finally(() => {
    activeSync = null;
  });
  return activeSync;
}

async function runSync(
  songIds: string[],
  onProgress: (progress: OfflineSyncProgress) => void
): Promise<void> {
  // Ask iOS not to evict these files when space runs low.
  await navigator.storage?.persist?.().catch(() => false);
  const cache = await caches.open(OFFLINE_CACHE);
  const wanted = new Map<string, string>();
  for (const id of songIds) {
    if (/^\d{1,20}$/.test(id)) wanted.set(await audioPath(id), id);
  }

  const storedPaths = new Set<string>();
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    if (wanted.has(path)) storedPaths.add(path);
    else await cache.delete(request); // un-liked song
  }

  const missing = [...wanted.keys()].filter((path) => !storedPaths.has(path));
  let stored = storedPaths.size;
  const report = (running: boolean) =>
    onProgress({ total: wanted.size, stored, running });
  report(missing.length > 0);

  for (const path of missing) {
    if (!navigator.onLine) break;
    try {
      const response = await fetch(path, {
        credentials: "include",
        cache: "no-store",
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      await cache.put(path, response);
      stored += 1;
      report(true);
    } catch (error) {
      // Quota full: stop rather than fail every remaining song.
      if (error instanceof DOMException && error.name === "QuotaExceededError")
        break;
    }
  }
  report(false);
}
