import {
  buildMiguHeaders,
  buildMiguSongUrlPath,
  buildMiguV3SearchPath,
  convertMiguSongToMusicTrack,
  convertMiguV3SearchSongToMusicTrack,
  fetchMiguPlaylistDetail as fetchMiguPlaylistDetailCore,
  fetchUpstreamWithDeadline,
  MIGU_MAX_PLAYLIST_PAGES,
  MIGU_PAGE_SIZE,
  MIGU_PLAYLIST_WALL_CLOCK_MS,
  parseMiguSongUrlResponse,
  type MiguPlaylistDetail,
  type MiguSongUrlResponse,
  type MiguV3SearchSongRaw,
  type MusicTrack,
  type UpstreamResponseType,
} from "@otter-music/shared";
import { proxyPrivateAudio } from "../proxy/audio";

export { MIGU_PAGE_SIZE, convertMiguSongToMusicTrack };

const MIGU_BASE_URL = "https://app.c.nf.migu.cn";
const MIGU_SEARCH_BASE_URL = "https://app.u.nf.migu.cn";
const MIGU_SHORT_LINK_HOST = "c.migu.cn";
const MIGU_SHARE_PAGE_HOST = "h5.nf.migu.cn";
const MIGU_SHARE_PLAYLIST_PATH = "/app/v4/p/share/playlist/index.html";
const MIGU_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MIGU_PLAYLIST_MAX_REQUESTS = MIGU_MAX_PLAYLIST_PAGES + 1;
const MIGU_PLAYLIST_REQUEST_DEADLINE_MS = 4_000;

interface PlaylistUpstreamBudget {
  deadline: number;
  requests: number;
}

function createPlaylistUpstreamBudget(): PlaylistUpstreamBudget {
  return {
    deadline: Date.now() + MIGU_PLAYLIST_WALL_CLOCK_MS,
    requests: 0,
  };
}

async function fetchPlaylistUpstream<T>(
  budget: PlaylistUpstreamBudget,
  input: RequestInfo | URL,
  init: RequestInit,
  read: (response: Response) => Promise<T> | T,
  responseType: UpstreamResponseType
): Promise<T> {
  const remainingMs = budget.deadline - Date.now();
  if (budget.requests >= MIGU_PLAYLIST_MAX_REQUESTS || remainingMs <= 0) {
    throw new Error("Migu playlist upstream budget exceeded");
  }
  budget.requests += 1;
  return fetchUpstreamWithDeadline(input, init, read, {
    responseType,
    deadlineMs: Math.min(remainingMs, MIGU_PLAYLIST_REQUEST_DEADLINE_MS),
  });
}

// ============================================================
// 短链解析
// ============================================================

export function isMiguPlaylistShortLink(urlStr: string): boolean {
  if (!urlStr || urlStr.length > 2_048) return false;
  try {
    const url = new URL(urlStr);
    return (
      url.protocol === "https:" &&
      url.hostname === MIGU_SHORT_LINK_HOST &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function parseMiguShareRedirectPlaylistId(
  urlStr: string
): string | null {
  try {
    const url = new URL(urlStr);
    if (
      url.protocol !== "https:" ||
      url.hostname !== MIGU_SHARE_PAGE_HOST ||
      url.pathname !== MIGU_SHARE_PLAYLIST_PATH ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    ) {
      return null;
    }
    const playlistId = url.searchParams.get("id");
    return playlistId && /^\d{1,20}$/.test(playlistId) ? playlistId : null;
  } catch {
    return null;
  }
}

export async function resolveMiguShortPlaylistId(
  urlStr: string,
  fetcher: typeof fetch = fetch
): Promise<string | null> {
  if (!isMiguPlaylistShortLink(urlStr)) return null;

  return fetchUpstreamWithDeadline(
    urlStr,
    {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": MIGU_USER_AGENT },
    },
    (response) => {
      const redirectUrl = response.headers.get("Location") || response.url;
      return parseMiguShareRedirectPlaylistId(redirectUrl);
    },
    { responseType: "none", fetcher }
  );
}

// ============================================================
// 歌单获取（直接 fetch + 调用 shared 核心算法）
// ============================================================

/**
 * 获取咪咕歌单详情
 */
export async function fetchMiguPlaylistDetail(
  playlistId: string
): Promise<MiguPlaylistDetail> {
  const budget = createPlaylistUpstreamBudget();
  return fetchMiguPlaylistDetailCore(playlistId, async (path: string) => {
    return fetchPlaylistUpstream(
      budget,
      `${MIGU_BASE_URL}${path}`,
      {
        headers: {
          "User-Agent": MIGU_USER_AGENT,
        },
      },
      async (response) => {
        if (!response.ok) throw new Error(`Migu API error: ${response.status}`);
        return response.text();
      },
      "text"
    );
  });
}

async function fetchMiguJson<T>(
  path: string,
  headers: Record<string, string> = {}
): Promise<T> {
  return fetchUpstreamWithDeadline(
    `${MIGU_BASE_URL}${path}`,
    {
      headers: {
        "User-Agent": MIGU_USER_AGENT,
        ...headers,
      },
    },
    async (response) => {
      if (!response.ok) throw new Error(`Migu API error: ${response.status}`);
      return response.json() as Promise<T>;
    },
    { responseType: "json" }
  );
}

// ============================================================
// 播放地址获取
// ============================================================

export async function fetchMiguSongUrl(
  copyrightId: string,
  contentId: string,
  br = 192
): Promise<string | null> {
  const response = await fetchMiguJson<MiguSongUrlResponse>(
    buildMiguSongUrlPath(copyrightId, contentId, br),
    buildMiguHeaders()
  );
  return parseMiguSongUrlResponse(response);
}

export async function proxyMiguAudio(
  url: string,
  range?: string | null
): Promise<Response> {
  return proxyPrivateAudio(
    url,
    {
      Referer: "https://music.migu.cn/",
      "User-Agent": MIGU_USER_AGENT,
    },
    range
  );
}

// ============================================================
// 搜索
// ============================================================

export async function fetchMiguSearch(
  keyword: string,
  page: number,
  rows = 20
): Promise<{ items: MusicTrack[]; hasMore: boolean }> {
  const path = buildMiguV3SearchPath(keyword, page, rows);
  const data = await fetchUpstreamWithDeadline(
    `${MIGU_SEARCH_BASE_URL}${path}`,
    {
      headers: {
        "User-Agent": MIGU_USER_AGENT,
        ...buildMiguHeaders(),
      },
    },
    (response) =>
      response.ok
        ? (response.json() as Promise<MiguV3SearchSongRaw[]>)
        : Promise.resolve([]),
    { responseType: "json" }
  );
  if (!Array.isArray(data) || !data.length) {
    return { items: [], hasMore: false };
  }

  return {
    items: data.map(convertMiguV3SearchSongToMusicTrack),
    hasMore: data.length >= rows,
  };
}
