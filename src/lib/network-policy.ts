import { useSyncExternalStore } from "react";

/**
 * The app has two modes, chosen by the owner:
 * - online: uses the network, and keeps downloading newly liked songs and
 *   their covers onto the phone;
 * - offline: plays only what is already stored on the phone and never touches
 *   the network (no radio activity, so the phone stays cool on the move).
 */
const LOCAL_ONLY_KEY = "music_local_only";
const listeners = new Set<() => void>();

function readManualLocalOnly(): boolean {
  try {
    return localStorage.getItem(LOCAL_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

let manualLocalOnly = readManualLocalOnly();

export function getManualLocalOnly(): boolean {
  return manualLocalOnly;
}

export function setManualLocalOnly(enabled: boolean): void {
  manualLocalOnly = enabled;
  try {
    if (enabled) localStorage.setItem(LOCAL_ONLY_KEY, "1");
    else localStorage.removeItem(LOCAL_ONLY_KEY);
  } catch {
    // Storage unavailable: the choice still holds for this session.
  }
  listeners.forEach((listener) => listener());
}

export function useManualLocalOnly(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getManualLocalOnly,
    () => false
  );
}

/** Offline mode: only songs stored on the phone may play; no network. */
export function isLocalOnly(): boolean {
  return manualLocalOnly;
}

/** Whether playback and background work may touch the network right now. */
export function canUseNetwork(): boolean {
  return navigator.onLine && !isLocalOnly();
}
