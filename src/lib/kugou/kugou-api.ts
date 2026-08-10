import { getApiUrl } from "@/lib/api/config";
import {
  convertKugouSongToMusicTrack,
  isKugouGlobalCollectionId,
  KUGOU_PAGE_SIZE,
} from "@shared/utils/music/kugou";
import type { KugouPlaylistDetail } from "@shared/types/music-platforms";

const KUGOU_PROXY_PREFIX = "/music-api/kugou";
const NETWORK_TIMEOUT = 12000;

export {
  convertKugouSongToMusicTrack,
  isKugouGlobalCollectionId,
  KUGOU_PAGE_SIZE,
};

const bffUrl = (path: string) => `${getApiUrl()}${KUGOU_PROXY_PREFIX}${path}`;

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout = NETWORK_TIMEOUT
) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export function parseKugouPlaylistUrl(urlStr: string): string | null {
  try {
    const url = new URL(
      urlStr.startsWith("http") ? urlStr : `https://${urlStr}`
    );
    const pathMatch = url.pathname.match(
      /(?:special\/single|plist\/list)\/(\d+)/
    );
    if (pathMatch) return pathMatch[1];
    const globalPath = url.pathname.match(/\/songlist\/(gcid_[a-z0-9]+)\/?/i);
    if (globalPath) return globalPath[1];
    const id = url.searchParams.get("specialid") || url.searchParams.get("id");
    if (id && (/^\d+$/.test(id) || /^gcid_[a-z0-9]+$/i.test(id))) return id;
    const qrCode = url.searchParams.get("qrcode");
    if (qrCode) return parseKugouPlaylistUrl(decodeURIComponent(qrCode));
    const globalId = url.searchParams.get("global_collection_id");
    return globalId && /^gcid_[a-z0-9]+$/i.test(globalId) ? globalId : null;
  } catch {
    return null;
  }
}

export async function resolveKugouPlaylistId(
  urlStr: string
): Promise<string | null> {
  try {
    const url = new URL(
      urlStr.startsWith("http") ? urlStr : `https://${urlStr}`
    );
    if (!/^t\d+\.kugou\.com$/i.test(url.hostname)) {
      return parseKugouPlaylistUrl(urlStr);
    }
    const response = await fetchWithTimeout(bffUrl("/resolve-shortlink"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.toString() }),
    });
    if (!response.ok) return null;
    const result = (await response.json()) as { resolvedUrl?: string };
    return result.resolvedUrl
      ? parseKugouPlaylistUrl(result.resolvedUrl)
      : null;
  } catch {
    return null;
  }
}

export async function getKugouPlaylistDetail(
  playlistId: string
): Promise<KugouPlaylistDetail> {
  const response = await fetchWithTimeout(bffUrl("/playlist"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playlistId }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(payload.error || `API error: ${response.status}`);
  }
  return response.json();
}
