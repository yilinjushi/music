import type { MusicTrack } from "@/types/music";

/**
 * Last-seen first page of the 红心 list, so the home page can show songs at
 * once on launch while the fresh list loads in the background. Track metadata
 * only (no credentials); removed on logout with the other session caches.
 */
const PREFIX = "home-list-v1:";

export interface HomeListSnapshot<T> {
  detail: T;
  tracks: MusicTrack[];
}

export function readHomeList<T>(id: string): HomeListSnapshot<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + id);
    if (!raw) return null;
    const value = JSON.parse(raw) as HomeListSnapshot<T>;
    return value?.detail && Array.isArray(value.tracks) && value.tracks.length
      ? value
      : null;
  } catch {
    return null;
  }
}

export function writeHomeList<T>(id: string, value: HomeListSnapshot<T>): void {
  try {
    localStorage.setItem(PREFIX + id, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the cache is only an optimisation.
  }
}

export function clearHomeList(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}
