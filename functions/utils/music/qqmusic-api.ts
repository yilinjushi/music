import {
  type MusicTrack,
  type QqPlaylistDetail,
  type QqSearchSongRaw,
  type QqVkeyResponse,
  type SearchPageResult,
  QQ_API_URL,
  QQ_FILE_CONFIG,
  QQ_REFERER,
  buildVkeyRequestBody,
  convertQqSearchSongToMusicTrack,
  decodeQqHtmlEntities,
  extractVkeyUrl,
  fetchUpstreamWithDeadline,
  normalizePersistableResourceUrl,
  parseQqPlaylistResponse,
} from "@otter-music/shared";
import forge from "node-forge";
import { proxyPrivateAudio } from "../proxy/audio";

// --- API 调用 ---

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const QQ_PLAYLIST_API_URL =
  "https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";

/**
 * 构建 QQ 音乐歌单 API 完整请求 URL。
 * 抽离为纯函数以便测试。
 */
export function buildQqPlaylistApiUrl(id: string): string {
  return `${QQ_PLAYLIST_API_URL}?type=1&json=1&utf8=1&nosign=1&disstid=${encodeURIComponent(id)}&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=GB2312&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0`;
}

/**
 * 根据歌单 ID 获取 QQ 音乐歌单详情。
 * 在 Cloudflare Worker 环境中运行，绕过浏览器 CORS 限制。
 */
export async function fetchQqPlaylistDetail(
  id: string
): Promise<QqPlaylistDetail> {
  const url = buildQqPlaylistApiUrl(id);
  const rawText = await fetchUpstreamWithDeadline(
    url,
    {
      headers: {
        Referer: QQ_REFERER,
        "User-Agent": USER_AGENT,
      },
    },
    async (response) => {
      if (!response.ok)
        throw new Error(`QQ Music API error: ${response.status}`);
      return response.text();
    },
    { responseType: "text" }
  );
  const data = parseQqPlaylistResponse(rawText);

  if (data.code !== 0)
    throw new Error(`QQ Music API returned code ${data.code}`);
  if (data.subcode && data.subcode !== 0)
    throw new Error(
      data.msg || `QQ Music API returned subcode ${data.subcode}`
    );
  if (!data.cdlist?.length) throw new Error("歌单不存在或已被删除");

  const cd = data.cdlist[0];

  return {
    name: cd.dissname,
    coverUrl: normalizePersistableResourceUrl(cd.logo),
    trackCount: cd.songnum,
    songs: cd.songlist || [],
  };
}

// --- QQ 音乐搜索 (Worker 端) ---

export async function fetchQqMusicSearch(
  query: string,
  page: number
): Promise<SearchPageResult<MusicTrack>> {
  return fetchUpstreamWithDeadline(
    QQ_API_URL,
    {
      method: "POST",
      headers: {
        Referer: QQ_REFERER,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Cookie: "uin=",
      },
      body: JSON.stringify({
        req_1: {
          method: "DoSearchForQQMusicDesktop",
          module: "music.search.SearchCgiService",
          param: {
            num_per_page: 20,
            page_num: page,
            query,
            search_type: 0,
          },
        },
      }),
    },
    async (response) => {
      if (!response.ok) return { items: [], hasMore: false };
      const data = (await response.json()) as {
        req_1?: {
          data?: {
            body?: { song?: { list?: QqSearchSongRaw[] } };
            meta?: { sum?: number };
          };
        };
      };
      const rawList = data.req_1?.data?.body?.song?.list;
      const list = Array.isArray(rawList) ? rawList : [];
      const rawTotal = data.req_1?.data?.meta?.sum;
      const total = Number.isFinite(rawTotal) ? Number(rawTotal) : 0;
      return {
        items: list.map(convertQqSearchSongToMusicTrack),
        hasMore: page * 20 < total,
      };
    },
    { responseType: "json" }
  );
}

// --- QQ 音乐歌词 (Worker 端) ---

export async function fetchQqMusicLyric(songmid: string) {
  const rawText = await fetchUpstreamWithDeadline(
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(songmid)}&pcachetime=${Date.now()}&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0`,
    {
      headers: {
        Referer: QQ_REFERER,
        "User-Agent": USER_AGENT,
        Cookie: "uin=",
      },
    },
    (response) => (response.ok ? response.text() : null),
    { responseType: "text" }
  );
  if (rawText === null) return null;
  const jsonStr = rawText
    .replace(/^[\w$.]+\s*\(/, "")
    .replace(/\)\s*;?\s*$/, "");
  const data = JSON.parse(jsonStr);
  const lyric = forge.util.decodeUtf8(forge.util.decode64(data.lyric || ""));
  let tlyric: string | undefined;
  if (data.trans) {
    tlyric = forge.util.decodeUtf8(forge.util.decode64(data.trans));
  }
  return {
    lyric: decodeQqHtmlEntities(lyric),
    tlyric: tlyric ? decodeQqHtmlEntities(tlyric) : undefined,
  };
}

// --- QQ 音乐音频 URL (Worker 端, vkey 直连) ---

/**
 * 通过 QQ 音乐 vkey API 获取音频直链。
 * 从请求质量开始向低档降级，不可播放时返回空 url。
 */
export async function fetchQqMusicUrl(
  songmid: string,
  quality: (typeof QQ_FILE_CONFIG)[number]["key"]
): Promise<{ url?: string }> {
  const requestedIndex = QQ_FILE_CONFIG.findIndex(
    (configuration) => configuration.key === quality
  );
  if (requestedIndex < 0) return {};
  // Preserve the requested ceiling while retaining the established fallback
  // order when that exact file is unavailable.
  const qualityKeys = QQ_FILE_CONFIG.slice(requestedIndex).map(
    (configuration) => configuration.key
  );
  const body = buildVkeyRequestBody(songmid, qualityKeys);

  return fetchUpstreamWithDeadline(
    QQ_API_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Referer: QQ_REFERER,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
    },
    async (response) => {
      if (!response.ok) return {};
      const data = (await response.json()) as QqVkeyResponse;
      const url = extractVkeyUrl(data);
      return url ? { url } : {};
    },
    { responseType: "json" }
  );
}

export async function proxyQqMusicAudio(
  url: string,
  range?: string | null
): Promise<Response> {
  return proxyPrivateAudio(
    url,
    {
      Referer: QQ_REFERER,
      "User-Agent": USER_AGENT,
    },
    range
  );
}
