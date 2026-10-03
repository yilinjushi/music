import { getProxyUrl } from "@/lib/api/config";
import {
  stringContainsSensitiveAssignment,
  urlContainsSensitiveCapability,
} from "@/lib/utils/sensitive-data";

const OPAQUE_AUDIO_PATHS = new Set([
  "/music-api/audio",
  "/music-api/netease/audio",
  "/music-api/qqmusic/audio",
  "/music-api/migu/audio",
  "/music-api/bilibili/audio",
]);

/**
 * Identifies only the app's same-origin capability-hiding media routes.
 * Matching the pathname alone is insufficient: a third-party origin can use
 * the same path and must remain eligible only for the normal HTTPS policy.
 */
export function isSameOriginOpaqueAudioUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    return (
      parsed.origin === window.location.origin &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      OPAQUE_AUDIO_PATHS.has(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * 判断 URL 是否指向 localhost / 127.0.0.1
 */
export function isLocalhostUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * 从代理 URL 中提取被代理的原始音频 URL。
 * 不是代理 URL 时原样返回。
 */
function parseProxyAudioUrl(
  url: string
): { proxy: URL; original: string } | null {
  let proxy: URL;
  try {
    proxy = new URL(url, window.location.origin);
  } catch {
    return null;
  }
  if (proxy.pathname !== "/proxy" || !proxy.searchParams.has("url")) {
    return null;
  }
  if (
    proxy.username ||
    proxy.password ||
    proxy.hash ||
    proxy.searchParams.getAll("url").length !== 1
  ) {
    throw new Error("UNSAFE_PROXY_TARGET");
  }
  const original = proxy.searchParams.get("url");
  if (!original) throw new Error("INVALID_PROXY_TARGET");
  return { proxy, original };
}

/**
 * 把音频 URL 转换为适合当前页面播放的形式：
 * - http:// 原始 URL → localhost 直连；已知远端明确改为 HTTPS 后再走代理
 * - 当前后端的代理 URL → 复验内层目标并规范化代理 envelope
 * - 任意外部/旧后端的 /proxy URL → 复验内层目标并用当前后端重包
 * - HTTPS、同源路径、localhost 开发流、blob/data 音频 → 严格验证后返回
 */
export function normalizeAudioUrlForPlayback(url: string): string {
  const hasControlCharacter = [...url].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!url || url !== url.trim() || hasControlCharacter) {
    throw new Error("UNSAFE_AUDIO_URL");
  }

  // Recognize legacy proxies by their explicit /proxy?url= envelope instead
  // of delegating to isProxyUrl(), which intentionally recognizes only the
  // current same-origin backend. getProxyUrl is the single fail-closed check
  // for HTTPS, userinfo and sensitive/capability assignments.
  const parsedProxy = parseProxyAudioUrl(url);
  if (parsedProxy) {
    if (stringContainsSensitiveAssignment(parsedProxy.proxy.search)) {
      throw new Error("SENSITIVE_PROXY_TARGET");
    }
    if (
      [...parsedProxy.proxy.searchParams.keys()].some((key) => key !== "url")
    ) {
      throw new Error("UNSAFE_PROXY_TARGET");
    }
    const rewrapped = getProxyUrl(parsedProxy.original);
    return rewrapped;
  }

  if (
    stringContainsSensitiveAssignment(url) ||
    urlContainsSensitiveCapability(url)
  ) {
    throw new Error("SENSITIVE_AUDIO_URL");
  }

  if (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\")) {
    const relative = new URL(url, window.location.origin);
    if (
      relative.origin !== window.location.origin ||
      relative.username ||
      relative.password ||
      relative.hash
    ) {
      throw new Error("UNSAFE_AUDIO_URL");
    }
    return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("UNSAFE_AUDIO_URL");
  }

  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("UNSAFE_AUDIO_URL");
  }

  if (parsed.protocol === "https:") return parsed.toString();

  if (parsed.protocol === "http:") {
    if (isLocalhostUrl(url)) return parsed.toString();
    parsed.protocol = "https:";
    return getProxyUrl(parsed.toString());
  }

  if (parsed.protocol === "blob:") {
    if (parsed.search) throw new Error("UNSAFE_AUDIO_URL");
    return url;
  }

  if (
    parsed.protocol === "data:" &&
    /^data:audio\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*(?:;base64)?,/i.test(url)
  ) {
    return url;
  }

  throw new Error("UNSAFE_AUDIO_URL");
}
