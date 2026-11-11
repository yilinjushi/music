import { useSyncExternalStore } from "react";

/**
 * Decides whether playback and background work may use the network.
 *
 * On a cellular connection (weak signal, cell handovers) every request keeps
 * the radio powered and heats the phone, so the app then behaves as if it were
 * offline: it only plays songs already stored on the phone and starts no
 * background sync. Android reports the connection type; iOS does not expose
 * it, so the owner can also switch "local only" on by hand.
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

/** True when the browser reports a cellular connection (Android only). */
export function isCellularConnection(): boolean {
  const connection = (
    navigator as Navigator & { connection?: { type?: string } }
  ).connection;
  return connection?.type === "cellular";
}

/** Only songs stored on the phone may play; no network work at all. */
export function isLocalOnly(): boolean {
  return manualLocalOnly || isCellularConnection();
}

/** Whether playback and background work may touch the network right now. */
export function canUseNetwork(): boolean {
  return navigator.onLine && !isLocalOnly();
}
