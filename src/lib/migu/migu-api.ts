import { fetchWithTimeout, getApiUrl, getProxyUrl } from "@/lib/api/config";
import {
  convertMiguSongToMusicTrack,
  MIGU_PAGE_SIZE,
  parseMiguTrackId,
} from "@shared/utils/music/migu";
import { forceHttps } from "@shared/utils/url";
import type { MiguPlaylistDetail } from "@shared/types/music-platforms";
import type { MusicTrack } from "@/types/music";

const MIGU_PROXY_PREFIX = "/music-api/migu";
const NETWORK_TIMEOUT = 12000;

export { convertMiguSongToMusicTrack, MIGU_PAGE_SIZE };

const bffUrl = (path: string) => `${getApiUrl()}${MIGU_PROXY_PREFIX}${path}`;

async function postBff<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T | null> {
  const response = await fetchWithTimeout(
    bffUrl(path),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
    NETWORK_TIMEOUT
  );
  return response.ok ? ((await response.json()) as T) : null;
}

export function parseMiguPlaylistUrl(urlStr: string): string | null {
  try {
    const normalized = urlStr.replace(
      "music.migu.cn/v3/my/playlist/",
      "music.migu.cn/v3/music/playlist/"
    );
    const url = new URL(
      normalized.startsWith("http") ? normalized : `https://${normalized}`
    );
    const pathMatch = url.pathname.match(/\/v3\/music\/playlist\/(\d+)/);
    if (pathMatch) return pathMatch[1];
    const id =
      url.searchParams.get("playlistId") ||
      url.searchParams.get("musicListId") ||
      url.searchParams.get("id");
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export async function resolveMiguPlaylistId(
  urlStr: string
): Promise<string | null> {
  const directId = parseMiguPlaylistUrl(urlStr);
  if (directId) return directId;
  try {
    const url = new URL(urlStr);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "c.migu.cn" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      url.hash
    ) {
      return null;
    }
    const result = await postBff<{ playlistId?: string }>("/resolve-playlist", {
      url: url.toString(),
    });
    return result?.playlistId && /^\d+$/.test(result.playlistId)
      ? result.playlistId
      : null;
  } catch {
    return null;
  }
}

export async function getMiguPlaylistDetail(
  playlistId: string
): Promise<MiguPlaylistDetail> {
  const response = await fetchWithTimeout(
    bffUrl("/playlist"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistId }),
    },
    NETWORK_TIMEOUT
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(payload.error || `API error: ${response.status}`);
  }
  return response.json();
}

export async function getMiguSongUrl(
  trackId: string,
  br = 192
): Promise<string | null> {
  const ids = parseMiguTrackId(trackId);
  if (!ids) return null;
  if (
    !/^[A-Za-z0-9.-]{1,128}$/.test(ids.copyrightId) ||
    !/^[A-Za-z0-9.-]{1,128}$/.test(ids.contentId) ||
    ![128, 192, 320, 999].includes(br)
  ) {
    return null;
  }
  return `/music-api/migu/audio?${new URLSearchParams({
    copyrightId: ids.copyrightId,
    contentId: ids.contentId,
    br: String(br),
  }).toString()}`;
}

export async function getMiguLyric(
  lyricUrl: string,
  signal?: AbortSignal
): Promise<{ lyric: string; tlyric: string } | null> {
  const normalizedUrl = lyricUrl.startsWith("//")
    ? `https:${lyricUrl}`
    : forceHttps(lyricUrl);
  if (!normalizedUrl.startsWith("https://")) return null;

  try {
    const response = await fetchWithTimeout(
      getProxyUrl(normalizedUrl),
      { signal },
      NETWORK_TIMEOUT
    );
    if (!response.ok) return null;
    return { lyric: await response.text(), tlyric: "" };
  } catch {
    return null;
  }
}

export async function searchMiguSongs(
  keyword: string,
  page: number,
  rows = 20,
  signal?: AbortSignal
): Promise<{ items: MusicTrack[]; hasMore: boolean }> {
  return (
    (await postBff<{ items: MusicTrack[]; hasMore: boolean }>(
      "/search",
      {
        keyword,
        page,
        rows,
      },
      signal
    )) ?? { items: [], hasMore: false }
  );
}
