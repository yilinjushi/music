import { MusicSource, MusicTrack } from "@/types/music";
import {
  getOrderedMusicApiUrls,
  markMusicApiUrlFailure,
  markMusicApiUrlSuccess,
} from "../api/config";
import { RawApiTrack } from "./types";
import { logger } from "@/lib/logger";
import { normalizePersistableResourceUrl } from "@shared/utils/url";
import { validateOpaqueMusicIdentifier } from "@/lib/utils/sensitive-data";

const REQUEST_TIMEOUT_MS = 10000;
const OPAQUE_AUDIO_SOURCES = new Set<MusicSource>(["netease", "joox", "kuwo"]);
const OPAQUE_AUDIO_BITRATES = new Set([128, 192, 320, 999]);

function isOpaqueAudioId(source: MusicSource, id: string): boolean {
  if (source === "netease") return /^\d{1,20}$/.test(id);
  if (source === "kuwo") return /^(?:MUSIC_)?\d{1,20}$/.test(id);
  if (source === "joox") {
    if (
      id.length < 2 ||
      id.length > 256 ||
      !/^[A-Za-z0-9+/_-]+={0,2}$/.test(id)
    ) {
      return false;
    }
    return id.includes("=") ? id.length % 4 === 0 : id.length % 4 !== 1;
  }
  return false;
}

export function buildGenericAudioPath(
  source: MusicSource,
  id: string,
  br = 192
): string | null {
  if (
    !OPAQUE_AUDIO_SOURCES.has(source) ||
    !isOpaqueAudioId(source, id) ||
    !OPAQUE_AUDIO_BITRATES.has(br)
  ) {
    return null;
  }
  return `/music-api/audio?${new URLSearchParams({
    source,
    id,
    br: String(br),
  }).toString()}`;
}

function normalizeResourceOrOpaque(value: unknown): string {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  if (!candidate) return "";
  const normalizedUrl = normalizePersistableResourceUrl(candidate);
  if (normalizedUrl) return normalizedUrl;
  return /^(?:https?:)?\/\//i.test(candidate) ? "" : candidate;
}

function normalizeOpaqueIdentifier(
  value: unknown,
  fallback: unknown,
  source: MusicSource
): string {
  const normalizeCandidate = (candidate: unknown): string => {
    if (typeof candidate === "number") {
      return Number.isFinite(candidate) ? String(candidate) : "";
    }
    return typeof candidate === "string" ? candidate.trim() : "";
  };
  const isAllowed = (candidate: string): boolean =>
    candidate.length > 0 &&
    validateOpaqueMusicIdentifier(candidate) &&
    (!OPAQUE_AUDIO_SOURCES.has(source) || isOpaqueAudioId(source, candidate));

  const candidate = normalizeCandidate(value);
  if (isAllowed(candidate)) {
    return candidate;
  }
  const fallbackId = normalizeCandidate(fallback);
  return isAllowed(fallbackId) ? fallbackId : "";
}

export const normalizeTrack = (
  t: RawApiTrack,
  source: MusicSource
): MusicTrack => ({
  id: String(t.id),
  name: t.name,
  artist: Array.isArray(t.artist) ? t.artist : [t.artist],
  album: t.album,
  pic_id: normalizeResourceOrOpaque(t.pic_id),
  url_id: normalizeOpaqueIdentifier(t.url_id, t.id, source),
  lyric_id: normalizeResourceOrOpaque(t.lyric_id),
  source,
  artist_ids: t.artist_ids,
  album_id: t.album_id,
  duration:
    Number.isFinite(t.duration) && (t.duration ?? 0) > 0
      ? t.duration
      : undefined,
});

/**
 * 判断错误是否为取消/中断请求
 * 使用 name 判断以避免跨 realm 的 instanceof 失效（如 Vitest 中的 DOMException）
 */
export const isAbort = (e: unknown) =>
  (e instanceof Error ||
    (typeof DOMException !== "undefined" && e instanceof DOMException)) &&
  (e as Error).name === "AbortError";

const buildUrl = (
  apiBase: string,
  params: Record<string, string | number | undefined>,
  source?: MusicSource
) => {
  const search = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.set(k, String(v));
  }

  if (source) {
    search.set("source", source);
  }

  return `${apiBase}?${search.toString()}`;
};

async function requestJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  } catch (e) {
    if (isAbort(e)) throw e;
    logger.error("music-provider", `Request failed: ${url}`, e);
    throw e;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function requestMusicApiJSON<T>(
  params: Record<string, string | number | undefined>,
  source: MusicSource,
  signal?: AbortSignal
): Promise<T> {
  const apiBases = getOrderedMusicApiUrls();
  let lastError: unknown;

  for (const apiBase of apiBases) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const url = buildUrl(apiBase, params, source);
    try {
      const result = await requestJSON<T>(url, signal);
      markMusicApiUrlSuccess(apiBase);
      return result;
    } catch (e) {
      if (isAbort(e)) throw e;
      markMusicApiUrlFailure(apiBase);
      lastError = e;
    }
  }

  throw lastError ?? new Error("No available music API endpoint");
}
