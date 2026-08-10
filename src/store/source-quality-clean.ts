import type { MusicSource } from "@/types/music";
import { isPersistableMusicSource } from "@/lib/utils/sensitive-data";
import { createSanitizingStateStorage } from "@/lib/storage-adapter";
import type { StateStorage } from "zustand/middleware";

const RECENT_WINDOW = 20;
const MAX_FAILS = 20;
const MAX_SOURCE_ENTRIES = 64;

export const SOURCE_QUALITY_STORE_VERSION = 3;

export interface CleanSourceStats {
  recent: boolean[];
  fails: number;
}

export interface CleanSourceQualityState {
  stats: Partial<Record<MusicSource, CleanSourceStats>>;
}

export function createSourceQualityStateStorage(
  baseStorage: StateStorage
): StateStorage {
  return createSanitizingStateStorage(baseStorage, {
    version: SOURCE_QUALITY_STORE_VERSION,
    sanitize: sanitizePersistedSourceQualityState,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sanitizeSourceStats(value: unknown): CleanSourceStats | null {
  if (!isRecord(value)) return null;
  const recent = Array.isArray(value.recent)
    ? value.recent.filter((item): item is boolean => typeof item === "boolean")
    : [];
  const fails =
    typeof value.fails === "number" &&
    Number.isSafeInteger(value.fails) &&
    value.fails >= 0
      ? Math.min(value.fails, MAX_FAILS)
      : 0;
  return { recent: recent.slice(-RECENT_WINDOW), fails };
}

export function sanitizePersistedSourceQualityState(
  value: unknown
): CleanSourceQualityState {
  const candidate = isRecord(value) ? value : {};
  const rawStats = isRecord(candidate.stats) ? candidate.stats : {};
  const stats: CleanSourceQualityState["stats"] = {};

  for (const [source, rawSourceStats] of Object.entries(rawStats).slice(
    0,
    MAX_SOURCE_ENTRIES
  )) {
    if (!isPersistableMusicSource(source)) continue;
    const sourceStats = sanitizeSourceStats(rawSourceStats);
    if (sourceStats) stats[source] = sourceStats;
  }
  return { stats };
}
