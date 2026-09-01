// functions/utils/cache.ts

import {
  classifyCanonicalSensitiveAssignments,
  isCanonicalCapabilityFieldName,
  isCanonicalSensitiveFieldName,
} from "@shared/utils/sensitive-fields";
import type { ApiResponseCache, CacheStorageLike } from "../types/hono";

/**
 * Cache policy is intentionally conservative: account-bound requests and any
 * payload that resembles a credential never reach Cache Storage.
 */
export const CACHE_CONFIG = {
  file: {
    maxAge: 86400 * 7,
  },
  thumb: {
    maxAge: 86400,
  },
  api: {
    maxAge: 3600,
  },
};

const CACHE_NAME = "otter-music-cache";
const MAX_TEXT_INSPECTION_BYTES = 1024 * 1024;

function getCloudflareCacheStorage(): CacheStorageLike {
  const storage = (globalThis as typeof globalThis & {
    caches?: CacheStorageLike;
  }).caches;
  if (!storage) throw new Error("Cache storage is unavailable");
  return storage;
}

function createCloudflareCache(): ApiResponseCache {
  return {
    async match(request) {
      const cache = await getCloudflareCacheStorage().open(CACHE_NAME);
      return (await cache.match(request)) ?? null;
    },
    async put(request, response) {
      const cache = await getCloudflareCacheStorage().open(CACHE_NAME);
      await cache.put(request, response);
    },
    async delete(request) {
      const cache = await getCloudflareCacheStorage().open(CACHE_NAME);
      return cache.delete(request);
    },
  };
}

function resolveResponseCache(cache?: ApiResponseCache): ApiResponseCache {
  return cache ?? createCloudflareCache();
}

export function isSensitiveFieldName(name: string): boolean {
  return isCanonicalSensitiveFieldName(name);
}

export function isCapabilityFieldName(name: string): boolean {
  return isCanonicalCapabilityFieldName(name);
}

export interface SensitiveStringClassification {
  hasCapability: boolean;
  hasCredential: boolean;
}

export function classifySensitiveString(
  value: string
): SensitiveStringClassification {
  return classifyCanonicalSensitiveAssignments(value);
}

export function containsSensitiveString(value: string): boolean {
  const classification = classifySensitiveString(value);
  return classification.hasCapability || classification.hasCredential;
}

export type SensitiveDataClassification = SensitiveStringClassification;

const MAX_SCAN_DEPTH = 32;
const MAX_SCAN_NODES = 20_000;
const MAX_SCAN_STRING_LENGTH = 128 * 1024;
const MAX_SCAN_COLLECTION_LENGTH = 5_000;
const MAX_SCAN_SEARCH_PARAMS = 256;

interface ScanContext {
  nodes: number;
  visiting: WeakSet<object>;
}

function safeClassification(): SensitiveDataClassification {
  return { hasCapability: false, hasCredential: false };
}

function rejectedClassification(): SensitiveDataClassification {
  return { hasCapability: false, hasCredential: true };
}

function mergeClassification(
  target: SensitiveDataClassification,
  child: SensitiveDataClassification
): void {
  target.hasCapability ||= child.hasCapability;
  target.hasCredential ||= child.hasCredential;
}

/**
 * Recursively distinguishes short-lived media capabilities from account and
 * API credentials. Capability endpoints may return the former privately, but
 * no browser-facing response is ever allowed to contain the latter.
 */
function classifyStringWithinBudget(
  value: string
): SensitiveDataClassification {
  return value.length > MAX_SCAN_STRING_LENGTH
    ? rejectedClassification()
    : classifySensitiveString(value);
}

function classifySearchParamsWithinBudget(
  searchParams: URLSearchParams,
  context: ScanContext
): SensitiveDataClassification {
  const result = safeClassification();
  let count = 0;
  for (const [name, value] of searchParams.entries()) {
    count += 1;
    context.nodes += 1;
    if (
      count > MAX_SCAN_SEARCH_PARAMS ||
      context.nodes > MAX_SCAN_NODES ||
      name.length > MAX_SCAN_STRING_LENGTH ||
      value.length > MAX_SCAN_STRING_LENGTH
    ) {
      return rejectedClassification();
    }
    if (isSensitiveFieldName(name)) {
      if (isCapabilityFieldName(name)) result.hasCapability = true;
      else result.hasCredential = true;
    }
    mergeClassification(result, classifyStringWithinBudget(value));
    if (result.hasCapability && result.hasCredential) break;
  }
  return result;
}

function classifySensitiveDataWithinBudget(
  value: unknown,
  context: ScanContext,
  depth: number
): SensitiveDataClassification {
  context.nodes += 1;
  if (context.nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) {
    return rejectedClassification();
  }
  if (typeof value === "string") return classifyStringWithinBudget(value);
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return safeClassification();
  }
  if (typeof value !== "object") return rejectedClassification();
  if (context.visiting.has(value)) return rejectedClassification();
  context.visiting.add(value);

  try {
    if (value instanceof Error) {
      return classifyStringWithinBudget(value.message);
    }
    if (value instanceof URL) {
      const result = classifyStringWithinBudget(value.toString());
      mergeClassification(
        result,
        classifySearchParamsWithinBudget(value.searchParams, context)
      );
      return result;
    }
    if (value instanceof URLSearchParams) {
      return classifySearchParamsWithinBudget(value, context);
    }
    if (value instanceof Headers) {
      const entries: Array<[string, string]> = [];
      value.forEach((child, name) => entries.push([name, child]));
      if (entries.length > MAX_SCAN_COLLECTION_LENGTH) {
        return rejectedClassification();
      }
      const result = safeClassification();
      for (const [name, child] of entries) {
        context.nodes += 1;
        if (
          context.nodes > MAX_SCAN_NODES ||
          name.length > MAX_SCAN_STRING_LENGTH ||
          child.length > MAX_SCAN_STRING_LENGTH
        ) {
          return rejectedClassification();
        }
        if (isSensitiveFieldName(name)) {
          if (isCapabilityFieldName(name)) result.hasCapability = true;
          else result.hasCredential = true;
        }
        mergeClassification(result, classifyStringWithinBudget(child));
        if (result.hasCapability && result.hasCredential) break;
      }
      return result;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_SCAN_COLLECTION_LENGTH) {
        return rejectedClassification();
      }
      const result = safeClassification();
      for (const child of value) {
        mergeClassification(
          result,
          classifySensitiveDataWithinBudget(child, context, depth + 1)
        );
        if (result.hasCapability && result.hasCredential) break;
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return rejectedClassification();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_SCAN_COLLECTION_LENGTH) {
      return rejectedClassification();
    }
    const result = safeClassification();
    for (const rawName of keys) {
      if (typeof rawName !== "string") return rejectedClassification();
      const descriptor = Object.getOwnPropertyDescriptor(value, rawName);
      if (!descriptor || !("value" in descriptor)) {
        return rejectedClassification();
      }
      if (rawName.length > MAX_SCAN_STRING_LENGTH) {
        return rejectedClassification();
      }
      if (isSensitiveFieldName(rawName)) {
        if (isCapabilityFieldName(rawName)) result.hasCapability = true;
        else result.hasCredential = true;
      }
      mergeClassification(
        result,
        classifySensitiveDataWithinBudget(descriptor.value, context, depth + 1)
      );
      if (result.hasCapability && result.hasCredential) break;
    }
    return result;
  } finally {
    context.visiting.delete(value);
  }
}

export function classifySensitiveData(
  value: unknown
): SensitiveDataClassification {
  return classifySensitiveDataWithinBudget(
    value,
    { nodes: 0, visiting: new WeakSet() },
    0
  );
}

/** Recursively detects credential- or capability-shaped fields and strings. */
export function containsSensitiveData(value: unknown): boolean {
  const classification = classifySensitiveData(value);
  return classification.hasCapability || classification.hasCredential;
}

export function classifySensitiveSearchParams(
  searchParams: URLSearchParams
): SensitiveDataClassification {
  return classifySearchParamsWithinBudget(searchParams, {
    nodes: 0,
    visiting: new WeakSet(),
  });
}

export function containsSensitiveSearchParams(
  searchParams: URLSearchParams
): boolean {
  const classification = classifySensitiveSearchParams(searchParams);
  return classification.hasCapability || classification.hasCredential;
}

export function isAccountRequest(request: Request): boolean {
  const url = new URL(request.url);
  const path = url.pathname.toLowerCase();
  return (
    path === "/netease" ||
    path.includes("/netease/") ||
    request.headers.has("authorization") ||
    request.headers.has("cookie") ||
    request.headers.has("x-real-cookie")
  );
}

/**
 * URL-resolution endpoints return short-lived playback capabilities. They are
 * never public/cacheable even when a particular provider currently returns an
 * unsigned URL.
 */
export function isCapabilityRequest(request: Request, body?: unknown): boolean {
  const url = new URL(request.url);
  const path = url.pathname.toLowerCase();
  const responseType = (
    url.searchParams.get("types") ??
    url.searchParams.get("type") ??
    ""
  ).toLowerCase();
  let bodyType: unknown;
  if (
    request.method.toUpperCase() === "POST" &&
    path.endsWith("/qqmusic/proxy") &&
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(body, "type");
    if (descriptor && "value" in descriptor) bodyType = descriptor.value;
  }

  return (
    responseType === "url" ||
    (typeof bodyType === "string" && bodyType.toLowerCase() === "url") ||
    path.endsWith("/audio") ||
    path.endsWith("/url") ||
    path.includes("/song-url") ||
    path.includes("/play-url")
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Returns an opaque, canonical cache key. Raw query values are never included
 * in the key, and sensitive/account-bound requests are declared uncacheable.
 */
export async function createCacheKey(
  request: Request
): Promise<Request | null> {
  if (
    request.method.toUpperCase() !== "GET" ||
    isAccountRequest(request) ||
    isCapabilityRequest(request)
  ) {
    return null;
  }

  const url = new URL(request.url);
  if (
    url.username ||
    url.password ||
    containsSensitiveSearchParams(url.searchParams)
  ) {
    return null;
  }

  const query = [...url.searchParams.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = leftKey.localeCompare(rightKey);
      return keyOrder || leftValue.localeCompare(rightValue);
    }
  );
  url.search = "";
  if (query.length > 0) {
    url.searchParams.set("q", await sha256(JSON.stringify(query)));
  }
  url.hash = "";

  return new Request(url.toString(), { method: "GET" });
}

function responseDisallowsStorage(response: Response): boolean {
  return /(?:^|,)\s*(?:no-store|private)(?:\s*(?:,|$)|\s*=)/i.test(
    response.headers.get("cache-control") || ""
  );
}

export async function responseContainsSensitiveData(
  response: Response
): Promise<boolean> {
  if (containsSensitiveData(response.headers)) return true;

  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  const contentLength = Number(response.headers.get("content-length") || "0");
  const isTextual =
    contentType.includes("application/json") ||
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("javascript");
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_TEXT_INSPECTION_BYTES
  ) {
    return isTextual;
  }

  try {
    if (contentType.includes("application/json")) {
      return containsSensitiveData(await response.clone().json());
    }
    if (isTextual) {
      return containsSensitiveString(await response.clone().text());
    }
  } catch {
    // Malformed or unreadable responses are not safe persistence candidates.
    return true;
  }

  return false;
}

export async function getFromCache(
  request: Request,
  responseCache?: ApiResponseCache
): Promise<Response | null> {
  const key = await createCacheKey(request);
  if (!key) return null;

  let cached: Response | null;
  try {
    cached = await resolveResponseCache(responseCache).match(key);
  } catch {
    // Cache is an optimization. A backend failure must not take down the
    // ordinary music API or turn it into an unbounded relay.
    return null;
  }
  if (!cached) return null;
  if (
    responseDisallowsStorage(cached) ||
    (await responseContainsSensitiveData(cached))
  ) {
    await resolveResponseCache(responseCache).delete(key).catch(() => false);
    return null;
  }
  return cached;
}

export async function putToCache(
  request: Request,
  response: Response,
  type: keyof typeof CACHE_CONFIG,
  responseCache?: ApiResponseCache
): Promise<boolean> {
  if (
    !response.ok ||
    responseDisallowsStorage(response) ||
    (await responseContainsSensitiveData(response))
  ) {
    return false;
  }

  const key = await createCacheKey(request);
  if (!key) return false;

  const maxAge = CACHE_CONFIG[type].maxAge;
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Cache-Control", `public, max-age=${maxAge}`);
  const cachedResponse = new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });

  try {
    await resolveResponseCache(responseCache).put(key, cachedResponse);
    return true;
  } catch {
    return false;
  }
}

export async function deleteCache(
  request: Request,
  responseCache?: ApiResponseCache
): Promise<boolean> {
  const key = await createCacheKey(request);
  if (!key) return false;
  try {
    return await resolveResponseCache(responseCache).delete(key);
  } catch {
    return false;
  }
}
