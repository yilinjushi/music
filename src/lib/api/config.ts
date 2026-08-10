import type { ApiResponse } from "@otter-music/shared";
import { normalizeCustomApiOrigin } from "./custom-api-origin";
import {
  stringContainsSensitiveAssignment,
  urlContainsSensitiveCapability,
} from "@/lib/utils/sensitive-data";

export const IS_WEB_PROD = import.meta.env.PROD;

const getDefaultApiUrl = () => window.location.origin;

const STORAGE_KEY_CUSTOM_API_URL = "otter_custom_api_url";

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private browsing.
  }
}

export function getApiUrl(): string {
  return getCustomApiUrl() || getDefaultApiUrl();
}

export function getCustomApiUrl(): string | null {
  const stored = getStorage<unknown>(STORAGE_KEY_CUSTOM_API_URL, null);
  if (typeof stored !== "string") {
    removeStorage(STORAGE_KEY_CUSTOM_API_URL);
    return null;
  }
  const normalized = normalizeCustomApiOrigin(stored);
  if (!normalized) {
    removeStorage(STORAGE_KEY_CUSTOM_API_URL);
    return null;
  }
  if (stored !== normalized) setStorage(STORAGE_KEY_CUSTOM_API_URL, normalized);
  return normalized;
}

export function setCustomApiUrl(url: string) {
  const normalized = normalizeCustomApiOrigin(url);
  if (!normalized) throw new Error("UNSAFE_API_ORIGIN");
  setStorage(STORAGE_KEY_CUSTOM_API_URL, normalized);
}

export function clearCustomApiUrl() {
  removeStorage(STORAGE_KEY_CUSTOM_API_URL);
}

const API_TIMEOUT_MS = 10000;
const MUSIC_API_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export const DEFAULT_MUSIC_API_URL = "/music-api";

const STORAGE_KEY_MUSIC_URLS = "otter_music_api_urls";
const STORAGE_KEY_MUSIC_URL_FAILURES = "otter_music_api_url_failures";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * 统一处理后端响应
 */
export async function unwrap<T>(
  resOrPromise: Response | Promise<Response>
): Promise<T> {
  const res = await resOrPromise;
  if (!res.ok) throw new ApiError(await res.text(), res.status);

  const { success, message, data } = (await res.json()) as ApiResponse<T>;
  if (!success) throw new Error(message || "请求失败");

  return data as T;
}

/**
 * 通用 Storage 读写封装
 */
const getStorage = <T>(key: string, fallback: T): T => {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
};
const setStorage = (key: string, val: unknown) =>
  localStorage.setItem(key, JSON.stringify(val));

/**
 * 获取 GD 音乐台 API 默认访问顺序
 */
function getDefaultMusicApiUrls(): string[] {
  const proxiedApiUrl = `${getApiUrl()}/music-api`;
  return [proxiedApiUrl];
}

function normalizeMusicApiUrl(value: unknown): string | null {
  if (typeof value !== "string" || stringContainsSensitiveAssignment(value)) {
    return null;
  }
  try {
    const currentOrigin = window.location.origin;
    const parsed = new URL(value, currentOrigin);
    if (
      parsed.origin !== currentOrigin ||
      parsed.username ||
      parsed.password ||
      parsed.pathname.replace(/\/+$/, "") !== DEFAULT_MUSIC_API_URL ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return `${currentOrigin}${DEFAULT_MUSIC_API_URL}`;
  } catch {
    return null;
  }
}

export const getMusicApiUrls = () => {
  const stored = getStorage<unknown>(STORAGE_KEY_MUSIC_URLS, null);
  if (!Array.isArray(stored)) return getDefaultMusicApiUrls();

  const safe = [
    ...new Set(stored.map(normalizeMusicApiUrl).filter(Boolean)),
  ] as string[];
  if (safe.length === 0) {
    removeStorage(STORAGE_KEY_MUSIC_URLS);
    return getDefaultMusicApiUrls();
  }
  setStorage(STORAGE_KEY_MUSIC_URLS, safe);
  return safe;
};

export const setMusicApiUrls = (urls: string[]) => {
  const safe = [
    ...new Set(urls.map(normalizeMusicApiUrl).filter(Boolean)),
  ] as string[];
  if (safe.length !== urls.length || safe.length === 0) {
    throw new Error("UNSAFE_MUSIC_API_URL");
  }
  setStorage(STORAGE_KEY_MUSIC_URLS, safe);
};

/**
 * 失效节点管理
 */
const getActiveFailures = (now = Date.now()) => {
  const stored = getStorage<unknown>(STORAGE_KEY_MUSIC_URL_FAILURES, {});
  const map: Record<string, number> = {};
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [rawUrl, expiry] of Object.entries(stored)) {
      const url = normalizeMusicApiUrl(rawUrl);
      if (url && typeof expiry === "number" && Number.isFinite(expiry)) {
        map[url] = expiry;
      }
    }
  }
  // 清理已过期的记录
  Object.keys(map).forEach((url) => map[url] <= now && delete map[url]);
  return map;
};

export function getOrderedMusicApiUrls(now = Date.now()): string[] {
  const urls = getMusicApiUrls();
  const fails = getActiveFailures(now);
  setStorage(STORAGE_KEY_MUSIC_URL_FAILURES, fails); // 同步清理后的状态

  return [
    ...urls.filter((url) => !fails[url]), // 正常的优先
    ...urls.filter((url) => fails[url]), // 冷却中的垫底
  ];
}

export const markMusicApiUrlFailure = (url: string, now = Date.now()) => {
  const normalized = normalizeMusicApiUrl(url);
  if (!normalized) return;
  setStorage(STORAGE_KEY_MUSIC_URL_FAILURES, {
    ...getActiveFailures(now),
    [normalized]: now + MUSIC_API_FAILURE_COOLDOWN_MS,
  });
};

export const markMusicApiUrlSuccess = (url: string, now = Date.now()) => {
  const normalized = normalizeMusicApiUrl(url);
  if (!normalized) return;
  const fails = getActiveFailures(now);
  if (fails[normalized]) {
    delete fails[normalized];
    setStorage(STORAGE_KEY_MUSIC_URL_FAILURES, fails);
  }
};

/**
 * 带超时的 Fetch
 */
export function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeout = API_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    window.clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  });
}

export function getProxyUrl(url: string) {
  if (urlContainsSensitiveCapability(url)) {
    throw new Error("SENSITIVE_PROXY_TARGET");
  }
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new Error("UNSAFE_PROXY_TARGET");
  }
  return `${getApiUrl()}/proxy?url=${encodeURIComponent(url)}`;
}

/**
 * 判断当前 URL 是否已经是代理 URL，防止死循环
 */
export function isProxyUrl(url: string): boolean {
  try {
    const u = new URL(url, window.location.origin);
    return u.origin === new URL(getApiUrl()).origin && u.pathname === "/proxy";
  } catch {
    return false;
  }
}
