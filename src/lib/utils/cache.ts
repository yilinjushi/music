import { mutate } from "swr";
import { logger } from "@/lib/logger";
import {
  isSensitiveAssignmentName,
  stringContainsSensitiveAssignment,
} from "@/lib/utils/sensitive-data";
import { sensitiveDecodeVariants } from "@shared/utils/sensitive-fields";

const CACHE_NAME = "otter-cache-v1";
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;
const STORAGE_PRESSURE_RATIO = 0.8;
const LEGACY_MARKET_PLAYLIST_PREFIX = "market-playlist:v2:";

const now = () => Date.now();
const req = (key: string) =>
  new Request(`https://cache.local/${encodeURIComponent(key)}`);

function isNeteaseBoundCacheKey(key: string): boolean {
  return key
    .trim()
    .toLowerCase()
    .split(":")
    .some((part) => part === "netease" || part === "_netease");
}

function isSessionDerivedNeteaseCacheKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (
    isNeteaseBoundCacheKey(normalized) ||
    normalized.startsWith(LEGACY_MARKET_PLAYLIST_PREFIX)
  );
}

export function isSensitiveCacheKey(key: string): boolean {
  // Every NetEase BFF response may be personalized by the server-side
  // HttpOnly session. Treat the whole namespace as account-bound even when a
  // particular response happens to contain only public-looking metadata.
  if (isSessionDerivedNeteaseCacheKey(key)) return true;
  if (stringContainsSensitiveAssignment(key)) return true;
  return key
    .split(/[^a-z0-9_-]+/i)
    .filter(Boolean)
    .some((part) => isSensitiveAssignmentName(part));
}

function stringContainsStatefulHttpUrl(value: string): boolean {
  for (const variant of sensitiveDecodeVariants(value)) {
    const candidates = variant.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
    for (const candidate of candidates) {
      try {
        const url = new URL(candidate);
        if (
          url.username ||
          url.password ||
          url.search.length > 0 ||
          url.hash.length > 0
        ) {
          return true;
        }
      } catch {
        // Malformed URL-like strings are handled by the credential scanner.
      }
    }
  }
  return false;
}

/** Credential-shaped or stateful URL values never enter Cache Storage/SWR. */
export function containsSensitiveCacheData(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): boolean {
  if (typeof value === "string") {
    return (
      stringContainsSensitiveAssignment(value) ||
      stringContainsStatefulHttpUrl(value)
    );
  }
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  // These objects are not JSON cache records and may encapsulate unreadable
  // headers or bodies, so fail closed instead of serializing them to `{}`.
  if (
    (typeof Response !== "undefined" && value instanceof Response) ||
    (typeof Blob !== "undefined" && value instanceof Blob) ||
    value instanceof ArrayBuffer
  ) {
    return true;
  }
  if (value instanceof URLSearchParams) {
    // URLSearchParams is query state by definition and JSON.stringify would
    // otherwise silently turn it into `{}`.
    return [...value].length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((child) => containsSensitiveCacheData(child, seen));
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !(value instanceof Date)
  ) {
    return true;
  }

  return Object.entries(value as Record<string, unknown>).some(
    ([name, child]) =>
      isSensitiveAssignmentName(name) || containsSensitiveCacheData(child, seen)
  );
}

/** 写入磁盘缓存 */
async function saveToDisk<T>(
  key: string,
  data: T,
  ttl: number,
  signal?: AbortSignal
) {
  if (
    isSensitiveCacheKey(key) ||
    containsSensitiveCacheData(data) ||
    signal?.aborted
  ) {
    return false;
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    if (signal?.aborted) return false;
    const ts = now();

    const res = new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "x-expiry": String(ts + ttl),
        "x-created-at": String(ts),
      },
    });

    await cache.put(req(key), res);
    return true;
  } catch {
    logger.warn("Cache", "Failed to save cache entry");
    return false;
  }
}

/** 从磁盘读取（含读时清理） */
async function getFromDisk<T>(
  key: string,
  signal?: AbortSignal
): Promise<T | null> {
  if (isSensitiveCacheKey(key) || signal?.aborted) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    if (signal?.aborted) return null;
    const request = req(key);
    const res = await cache.match(request);
    if (signal?.aborted) return null;

    if (!res) return null;

    const isExpired = Number(res.headers.get("x-expiry") || 0) <= now();
    if (isExpired) {
      void cache.delete(request);
      return null;
    }

    const value = (await res.json()) as T;
    if (signal?.aborted) return null;
    if (containsSensitiveCacheData(value)) {
      await cache.delete(request);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function isUnderStoragePressure() {
  try {
    if (!navigator.storage?.estimate) return false;
    const { usage, quota } = await navigator.storage.estimate();
    return !!usage && !!quota && usage / quota >= STORAGE_PRESSURE_RATIO;
  } catch {
    return false;
  }
}

/** 核心清理：始终删过期；只有在存储压力大时才删旧 */
export async function cleanupCache() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    const nowTime = now();

    const items: { request: Request; createdAt: number }[] = [];
    const expiredDeletes: Promise<boolean>[] = [];

    for (const request of requests) {
      const res = await cache.match(request);
      if (!res) continue;

      if (Number(res.headers.get("x-expiry") || 0) <= nowTime) {
        expiredDeletes.push(cache.delete(request));
        continue;
      }

      items.push({
        request,
        createdAt: Number(res.headers.get("x-created-at") || 0),
      });
    }

    if (expiredDeletes.length) {
      await Promise.all(expiredDeletes);
    }

    // 平时不做人为容量限制；只有在接近配额时才删一部分老数据
    if (await isUnderStoragePressure()) {
      items.sort((a, b) => a.createdAt - b.createdAt);
      const deleteCount = Math.ceil(items.length * 0.3); // 删最旧的 30%
      const toDelete = items.slice(0, deleteCount);
      await Promise.all(toDelete.map((item) => cache.delete(item.request)));
    }
  } catch {
    logger.warn("Cache", "Failed to prune cache");
  }
}

/**
 * Earlier builds wrote resolved media URLs to this generic Cache Storage.
 * Provider URLs can be bearer capabilities, so remove every legacy `url:`
 * entry at startup even when its old TTL has not elapsed. New builds keep
 * resolved URLs only in the in-memory URL store.
 */
export async function purgeLegacyResolvedUrlCache(): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    const legacyUrlRequests = requests.filter((request) => {
      try {
        const url = new URL(request.url);
        if (url.origin !== "https://cache.local") return false;
        return decodeURIComponent(url.pathname.slice(1)).startsWith("url:");
      } catch {
        return false;
      }
    });
    await Promise.all(
      legacyUrlRequests.map((request) => cache.delete(request))
    );
  } catch {
    // Cache Storage can be unavailable in private browsing and unit tests.
  }
}

/**
 * Older builds persisted parsed NetEase responses under `netease:*` and
 * `market-playlist:v2:*` keys. Those responses may have been derived from an
 * authenticated server session, so remove them from both Cache Storage and
 * SWR during startup migration.
 */
export async function purgeLegacyNeteaseDataCache(): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    const legacyNeteaseRequests = requests.filter((request) => {
      try {
        const url = new URL(request.url);
        if (url.origin !== "https://cache.local") return false;
        return isSessionDerivedNeteaseCacheKey(
          decodeURIComponent(url.pathname.slice(1))
        );
      } catch {
        return false;
      }
    });
    await Promise.all(
      legacyNeteaseRequests.map((request) => cache.delete(request))
    );
  } catch {
    // Cache Storage can be unavailable in private browsing and unit tests.
  }

  try {
    await mutate(
      (key) => typeof key === "string" && isSessionDerivedNeteaseCacheKey(key),
      undefined,
      { revalidate: false }
    );
  } catch {
    // Clearing the in-memory cache is best-effort when no SWR provider exists.
  }
}

/**
 * Remove all application data-response caches. Account logout uses the broad
 * variant intentionally: a public playlist may still contain private account
 * context, and retaining a little less metadata is safer than guessing which
 * keys are personal.
 */
export async function clearDataCache(): Promise<void> {
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    // Cache Storage can be unavailable in private browsing and unit tests.
  }

  try {
    await mutate(() => true, undefined, { revalidate: false });
  } catch {
    // Clearing the in-memory cache is best-effort when no SWR provider exists.
  }
}

/**
 * Remove one non-sensitive data-response cache entry from both Cache Storage
 * and SWR's in-memory state. URL recovery uses this narrow variant so an
 * expired signed media URL cannot be returned again by cachedFetch.
 */
export async function deleteCachedValue(
  key: string,
  signal?: AbortSignal
): Promise<void> {
  if (isSensitiveCacheKey(key) || signal?.aborted) return;

  try {
    const cache = await caches.open(CACHE_NAME);
    if (signal?.aborted) return;
    await cache.delete(req(key));
  } catch {
    // Cache Storage can be unavailable in private browsing and unit tests.
  }

  if (signal?.aborted) return;
  try {
    await mutate(key, undefined, { revalidate: false });
  } catch {
    // Clearing the in-memory cache is best-effort when no SWR provider exists.
  }
}

/** 核心请求函数 */
export async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<T | null>,
  ttl: number = DEFAULT_TTL,
  signal?: AbortSignal
): Promise<T | null> {
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw Object.assign(new Error("CACHE_REQUEST_ABORTED"), {
        name: "AbortError",
      });
    }
  };

  throwIfAborted();
  if (isSensitiveCacheKey(key)) {
    const sensitiveFresh = await fetcher();
    throwIfAborted();
    return sensitiveFresh;
  }

  const disk = await getFromDisk<T>(key, signal);
  throwIfAborted();
  if (disk !== null) return disk;

  const fresh = await fetcher();
  throwIfAborted();
  if (fresh === null) return null;
  if (
    containsSensitiveCacheData(fresh) ||
    (typeof fresh === "string" && fresh.startsWith("blob:"))
  ) {
    return fresh;
  }

  await saveToDisk(key, fresh, ttl, signal);
  throwIfAborted();
  await mutate(key, fresh, { revalidate: false });
  throwIfAborted();
  return fresh;
}
