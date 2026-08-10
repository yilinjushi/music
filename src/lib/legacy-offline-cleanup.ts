import { idbStorage } from "@/lib/storage-adapter";

const LEGACY_OFFLINE_STORE_KEY = "oh_offline_store";
const LEGACY_AUDIO_CACHE = "audio-stream-cache";
const RETIRED_SYNC_STORE_KEY = "oh_sync_store";
const RETIRED_SYNC_DEVICE_KEY = "__oh_dk__";

/**
 * Remove state left by the upstream runtime audio cache. Cleanup is best effort
 * so unavailable storage APIs never block the first PWA render.
 */
export async function clearLegacyOfflineArtifacts(): Promise<void> {
  const operations: Promise<unknown>[] = [
    Promise.resolve(idbStorage.removeItem(LEGACY_OFFLINE_STORE_KEY)),
  ];

  if (typeof caches !== "undefined") {
    operations.push(caches.delete(LEGACY_AUDIO_CACHE));
  }

  await Promise.allSettled(operations);
}

/**
 * Remote sync was retired because the configured KV storage cannot provide an
 * atomic merge. Remove both the old encrypted sync credential and its
 * sync-only device key so a retired capability is not retained on disk.
 */
export async function clearRetiredSyncArtifacts(): Promise<void> {
  try {
    localStorage.removeItem(RETIRED_SYNC_STORE_KEY);
    localStorage.removeItem(RETIRED_SYNC_DEVICE_KEY);
  } catch {
    // IndexedDB cleanup below remains authoritative when localStorage is absent.
  }
  await Promise.allSettled([
    Promise.resolve(idbStorage.removeItem(RETIRED_SYNC_STORE_KEY)),
    Promise.resolve(idbStorage.removeItem(RETIRED_SYNC_DEVICE_KEY)),
  ]);
}
