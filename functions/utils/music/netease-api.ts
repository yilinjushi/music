import {
  requestWeapi,
  buildCookie,
  getRandomDomesticIp,
  BASE_URL,
  PC_USER_AGENT,
  UpstreamDeadlineError,
  fetchUpstreamWithDeadline,
  weapi,
} from "@otter-music/shared";
import forge from "node-forge/lib/forge";
import "node-forge/lib/md5";
import type {
  QrKeyResponse,
  QrCheckResponse,
  UserProfile,
  UserPlaylist,
  PlaylistDetail,
  SongDetail,
  SearchResult,
  RecommendPlaylist,
  Toplist,
  AlbumDetail,
  ArtistDetail,
  ResolveUrlResult,
} from "./netease-types";
import { proxyPrivateAudio } from "../proxy/audio";

export const NETEASE_PLAYLIST_MAX_TRACKS = 500;
export const NETEASE_PLAYLIST_PAGE_SIZE = 100;
export const NETEASE_PLAYLIST_MAX_TOTAL_TRACKS = 20_000;
export const NETEASE_PLAYLIST_TRACK_BATCH_SIZE = 100;
const NETEASE_PLAYLIST_BASE_REQUESTS =
  1 +
  Math.ceil(NETEASE_PLAYLIST_MAX_TRACKS / NETEASE_PLAYLIST_TRACK_BATCH_SIZE);
// Doubled so one retry per request (detail + each track batch) still fits
// inside the budget when a large playlist hits a transient upstream error.
export const NETEASE_PLAYLIST_MAX_REQUESTS = NETEASE_PLAYLIST_BASE_REQUESTS * 2;
// Mirrors the client's extended PLAYLIST_DETAIL_TIMEOUT_MS (30s) minus a
// margin for response transit/parsing, so large mobile playlists (300+
// tracks) actually get the time the client is already willing to wait.
export const NETEASE_PLAYLIST_WALL_CLOCK_MS = 25_000;

const NETEASE_PLAYLIST_REQUEST_DEADLINE_MS = 9_000;
const NETEASE_PLAYLIST_ID = /^(?:(?:neplaylist|ne_playlist)_)?\d{1,20}$/;

interface PlaylistUpstreamBudget {
  deadline: number;
  requests: number;
}

class NetEasePlaylistHttpError extends Error {
  constructor(readonly status: number) {
    super(`NetEase WEAPI error: ${status}`);
    this.name = "NetEasePlaylistHttpError";
  }
}

function isRetryablePlaylistRequestError(error: unknown): boolean {
  if (error instanceof UpstreamDeadlineError) return true;
  // Fetch network failures surface as TypeError in the Workers runtime.
  if (error instanceof TypeError) return true;
  return (
    error instanceof NetEasePlaylistHttpError &&
    (error.status === 408 || error.status >= 500)
  );
}

function createPlaylistUpstreamBudget(): PlaylistUpstreamBudget {
  return {
    deadline: Date.now() + NETEASE_PLAYLIST_WALL_CLOCK_MS,
    requests: 0,
  };
}

async function requestPlaylistWeapi<T>(
  budget: PlaylistUpstreamBudget,
  url: string,
  data: Record<string, unknown>,
  cookie: string
): Promise<T> {
  const encData = weapi(data);
  const params = new URLSearchParams(
    encData as Record<string, string>
  ).toString();
  const fakeIp = getRandomDomesticIp();
  const remainingMs = budget.deadline - Date.now();
  if (budget.requests >= NETEASE_PLAYLIST_MAX_REQUESTS || remainingMs <= 0) {
    throw new Error("NetEase playlist upstream budget exceeded");
  }
  budget.requests += 1;

  return fetchUpstreamWithDeadline(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": PC_USER_AGENT,
        Referer: BASE_URL,
        Origin: BASE_URL,
        "X-Real-IP": fakeIp,
        "X-Forwarded-For": fakeIp,
        Cookie: buildCookie(cookie),
      },
      body: params,
    },
    async (response) => {
      if (!response.ok) {
        throw new NetEasePlaylistHttpError(response.status);
      }
      return (await response.json()) as T;
    },
    {
      responseType: "json",
      deadlineMs: Math.min(remainingMs, NETEASE_PLAYLIST_REQUEST_DEADLINE_MS),
    }
  );
}

// Retry one transient network/deadline/server failure (budget permitting).
// Client errors, malformed JSON, body-limit failures, and validation errors
// fail immediately instead of amplifying a deterministic upstream failure.
async function requestPlaylistWeapiWithRetry<T>(
  budget: PlaylistUpstreamBudget,
  url: string,
  data: Record<string, unknown>,
  cookie: string
): Promise<T> {
  try {
    return await requestPlaylistWeapi<T>(budget, url, data, cookie);
  } catch (error) {
    if (
      !isRetryablePlaylistRequestError(error) ||
      budget.deadline - Date.now() <= 0
    ) {
      throw error;
    }
    return await requestPlaylistWeapi<T>(budget, url, data, cookie);
  }
}

/* =========================================================
 * 业务 API
 * ========================================================= */

/**
 * 获取歌曲播放 URL (核心：EAPI/WEAPI 双轨降级)
 */
export async function getSongUrl(
  id: string,
  br: number = 999000,
  cookie: string = ""
) {
  const realId = id.replace(/^(netrack_|ne_track_)/, "");

  const weapiData = {
    ids: `[${realId}]`,
    level: br >= 320000 ? "higher" : "standard",
    encodeType: "mp3",
    csrf_token: "",
  };

  return requestWeapi<{ data: { url: string; br: number; size: number }[] }>(
    `${BASE_URL}/weapi/song/enhance/player/url/v1`,
    weapiData,
    cookie
  );
}

export async function proxyNeteaseAudio(
  url: string,
  range?: string | null
): Promise<Response> {
  return proxyPrivateAudio(
    url,
    {
      Referer: `${BASE_URL}/`,
      "User-Agent": PC_USER_AGENT,
    },
    range
  );
}

// ---------- 下方全线使用 requestWeapi 替代原本脆弱的 request ----------

export async function getQrKey() {
  return requestWeapi<QrKeyResponse>(`${BASE_URL}/weapi/login/qrcode/unikey`, {
    type: 1,
  });
}

export async function checkQrStatus(key: string) {
  return requestWeapi<QrCheckResponse>(
    `${BASE_URL}/weapi/login/qrcode/client/login`,
    { key, type: 1 }
  );
}

export async function getMyInfo(cookie: string) {
  return requestWeapi<{ profile: UserProfile }>(
    `${BASE_URL}/api/nuser/account/get`,
    {},
    cookie
  );
}

export async function getUserPlaylists(
  userId: string,
  cookie: string,
  limit: number = 100,
  offset: number = 0
) {
  const url = `${BASE_URL}/api/user/playlist`;
  const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
  const safeOffset = Math.min(10_000, Math.max(0, Math.trunc(offset)));
  const params = new URLSearchParams({
    uid: userId,
    limit: String(safeLimit),
    offset: String(safeOffset),
    includeVideo: "true",
  });
  const fakeIp = getRandomDomesticIp();

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": PC_USER_AGENT,
    Referer: BASE_URL,
    Origin: BASE_URL,
    "X-Real-IP": fakeIp,
    "X-Forwarded-For": fakeIp,
    Cookie: buildCookie(cookie),
  };

  const json = await fetchUpstreamWithDeadline(
    url,
    {
      method: "POST",
      headers,
      body: params.toString(),
    },
    (response) => response.json(),
    { responseType: "json" }
  );
  return json as { playlist: UserPlaylist[]; code: number; more?: boolean };
}

export async function getPlaylistDetail(
  playlistId: string,
  cookie: string,
  options: NeteasePlaylistPageOptions = {}
): Promise<PlaylistDetail> {
  if (!NETEASE_PLAYLIST_ID.test(playlistId)) {
    throw new TypeError("Invalid NetEase playlist ID");
  }
  const offset = options.offset ?? 0;
  const limit = options.limit ?? NETEASE_PLAYLIST_PAGE_SIZE;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > NETEASE_PLAYLIST_MAX_TOTAL_TRACKS ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > NETEASE_PLAYLIST_MAX_TRACKS
  ) {
    throw new TypeError("Invalid NetEase playlist pagination");
  }
  const realId = playlistId.replace(/^(neplaylist_|ne_playlist_)/, "");
  const budget = createPlaylistUpstreamBudget();
  const data = {
    id: realId,
    offset,
    total: true,
    limit,
    n: limit,
    csrf_token: "",
  };
  const res = await requestPlaylistWeapiWithRetry<{
    playlist?: Record<string, unknown>;
  }>(budget, `${BASE_URL}/weapi/v3/playlist/detail`, data, cookie);

  const playlist = res.playlist;
  if (!playlist || !Array.isArray(playlist.trackIds)) {
    throw new Error("Invalid NetEase playlist response");
  }
  const reportedTrackCount = playlist.trackCount;
  if (
    playlist.trackIds.length > NETEASE_PLAYLIST_MAX_TOTAL_TRACKS ||
    (reportedTrackCount !== undefined &&
      (typeof reportedTrackCount !== "number" ||
        !Number.isSafeInteger(reportedTrackCount) ||
        reportedTrackCount < 0 ||
        reportedTrackCount > NETEASE_PLAYLIST_MAX_TOTAL_TRACKS))
  ) {
    throw new Error("NetEase playlist exceeds the safe track limit");
  }
  const allTrackIds = playlist.trackIds.map((item) => {
    const id =
      item && typeof item === "object"
        ? (item as Record<string, unknown>).id
        : undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error("Invalid NetEase playlist track ID");
    }
    return id;
  });
  const totalTrackCount =
    typeof reportedTrackCount === "number"
      ? reportedTrackCount
      : Math.max(allTrackIds.length, offset + allTrackIds.length);
  if (totalTrackCount > NETEASE_PLAYLIST_MAX_TOTAL_TRACKS) {
    throw new Error("NetEase playlist exceeds the safe track limit");
  }
  const receivedCompleteTrackList =
    allTrackIds.length > limit ||
    (typeof reportedTrackCount === "number" &&
      allTrackIds.length >= totalTrackCount);
  const pageItems =
    offset >= totalTrackCount
      ? []
      : receivedCompleteTrackList
        ? playlist.trackIds.slice(offset, offset + limit)
        : playlist.trackIds;
  const pageTrackIds = pageItems.map((item) => {
    const id =
      item && typeof item === "object"
        ? (item as Record<string, unknown>).id
        : undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error("Invalid NetEase playlist track ID");
    }
    return id;
  });
  const tracks = await getPlaylistTracksDetail(pageTrackIds, cookie, budget);
  const nextOffset = offset + pageTrackIds.length;

  return {
    ...playlist,
    trackCount: totalTrackCount,
    trackIds: pageItems,
    tracks,
    hasMore: pageTrackIds.length > 0 && nextOffset < totalTrackCount,
    nextOffset,
  } as PlaylistDetail;
}

export interface NeteasePlaylistPageOptions {
  offset?: number;
  limit?: number;
}

async function getPlaylistTracksDetail(
  trackIds: number[],
  cookie: string,
  budget: PlaylistUpstreamBudget
): Promise<SongDetail[]> {
  const url = `${BASE_URL}/weapi/v3/song/detail`;
  const batches: number[][] = [];
  for (
    let index = 0;
    index < trackIds.length;
    index += NETEASE_PLAYLIST_TRACK_BATCH_SIZE
  ) {
    batches.push(
      trackIds.slice(index, index + NETEASE_PLAYLIST_TRACK_BATCH_SIZE)
    );
  }

  const responses = await Promise.all(
    batches.map(async (batch) => {
      const c = `[${batch.map((id) => `{"id":${id}}`).join(",")}]`;
      const ids = `[${batch.join(",")}]`;
      const response = await requestPlaylistWeapiWithRetry<{
        songs?: SongDetail[];
      }>(budget, url, { c, ids }, cookie);
      if (!Array.isArray(response.songs)) {
        throw new Error("Invalid NetEase song detail response");
      }
      if (response.songs.length > batch.length) {
        throw new Error("NetEase song detail response exceeded its batch");
      }
      const batchIds = new Set(batch);
      const responseIds = new Set<number>();
      for (const song of response.songs) {
        const id = song?.id;
        if (
          typeof id !== "number" ||
          !Number.isSafeInteger(id) ||
          !batchIds.has(id) ||
          responseIds.has(id)
        ) {
          throw new Error("Invalid NetEase song detail response identity");
        }
        responseIds.add(id);
      }
      return response.songs;
    })
  );

  const result = responses.flat();
  if (result.length > NETEASE_PLAYLIST_MAX_TRACKS) {
    throw new Error("NetEase song detail response exceeded the safe limit");
  }
  return result;
}

export async function loginCellphone(phone: string, password: string) {
  const passwordHash = forge.md.md5
    .create()
    .update(forge.util.encodeUtf8(password))
    .digest()
    .toHex();
  return requestWeapi<{
    code: number;
    message?: string;
    profile?: UserProfile;
    account?: { id?: number };
  }>(`${BASE_URL}/weapi/w/login/cellphone`, {
    type: "1",
    https: "true",
    phone,
    countrycode: "86",
    password: passwordHash,
    rememberLogin: "true",
  });
}

async function getTracksDetail(trackIds: number[], cookie: string) {
  const url = `${BASE_URL}/weapi/v3/song/detail`;
  const BATCH_SIZE = NETEASE_PLAYLIST_TRACK_BATCH_SIZE;
  const result: SongDetail[] = [];

  if (trackIds.length > NETEASE_PLAYLIST_MAX_TRACKS) {
    throw new Error("NetEase track detail exceeds the safe track limit");
  }

  for (let i = 0; i < trackIds.length; i += BATCH_SIZE) {
    const batch = trackIds.slice(i, i + BATCH_SIZE);
    const c = "[" + batch.map((id) => `{"id":${id}}`).join(",") + "]";
    const ids = "[" + batch.join(",") + "]";

    const res = await requestWeapi<{ songs: SongDetail[] }>(
      url,
      { c, ids },
      cookie
    );
    if (res.data.songs) result.push(...res.data.songs);
  }
  return result;
}

export async function search(
  keyword: string,
  type: number = 1,
  page: number = 1,
  limit: number = 20,
  cookie: string = ""
) {
  const offset = (page - 1) * limit;
  const fakeIp = getRandomDomesticIp();

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": PC_USER_AGENT,
    Referer: BASE_URL,
    Origin: BASE_URL,
    "X-Real-IP": fakeIp,
    "X-Forwarded-For": fakeIp,
    Cookie: buildCookie(cookie),
  };

  const params = new URLSearchParams({
    s: keyword,
    type: String(type),
    offset: String(offset),
    limit: String(limit),
  });
  const json = await fetchUpstreamWithDeadline(
    `${BASE_URL}/api/search/pc`,
    {
      method: "POST",
      headers,
      body: params.toString(),
    },
    async (response) => {
      if (!response.ok)
        throw new Error(`NetEase Search API Error: ${response.status}`);
      return response.json();
    },
    { responseType: "json" }
  );
  return { data: json as { result: SearchResult; code: number } };
}

export async function getLyric(id: string, cookie: string = "") {
  const realId = id.replace(/^(netrack_|ne_track_)/, "");
  return requestWeapi<{ lrc: { lyric: string }; tlyric: { lyric: string } }>(
    `${BASE_URL}/weapi/song/lyric`,
    { id: realId, lv: -1, tv: -1 },
    cookie
  );
}

export async function getSongDetail(id: string, cookie: string = "") {
  const realId = id.replace(/^(netrack_|ne_track_)/, "");
  const tracks = await getTracksDetail([parseInt(realId)], cookie);
  return tracks[0];
}

export async function getRecommendPlaylists(cookie: string) {
  return requestWeapi<{ result: RecommendPlaylist[] }>(
    `${BASE_URL}/weapi/personalized/playlist`,
    { limit: 20, total: true, n: 20 },
    cookie
  );
}

export async function getToplist(cookie: string = "") {
  return requestWeapi<{ list: Toplist[] }>(
    `${BASE_URL}/weapi/toplist/detail`,
    {},
    cookie
  );
}

export async function getAlbum(id: string, cookie: string = "") {
  const realId = id.replace(/^(nealbum_|ne_album_)/, "");
  return requestWeapi<AlbumDetail>(
    `${BASE_URL}/weapi/v1/album/${realId}`,
    {},
    cookie
  );
}

export async function getArtist(id: string, cookie: string = "") {
  const realId = id.replace(/^(neartist_|ne_artist_)/, "");
  return requestWeapi<ArtistDetail>(
    `${BASE_URL}/weapi/v1/artist/${realId}`,
    {},
    cookie
  );
}

export async function getPlaylists(
  cat: string = "全部",
  order: string = "hot",
  limit: number = 35,
  offset: number = 0,
  cookie: string = ""
) {
  return requestWeapi<{ playlists: UserPlaylist[] }>(
    `${BASE_URL}/weapi/playlist/list`,
    { cat, order, limit, offset, total: true },
    cookie
  );
}

export async function getPlaylistDynamicDetail(
  id: string,
  cookie: string = ""
) {
  const realId = id.replace(/^(neplaylist_|ne_playlist_)/, "");
  return requestWeapi(
    `${BASE_URL}/weapi/playlist/detail/dynamic`,
    { id: realId },
    cookie
  );
}

export async function getAlbumDynamicDetail(id: string, cookie: string = "") {
  const realId = id.replace(/^(nealbum_|ne_album_)/, "");
  return requestWeapi(
    `${BASE_URL}/weapi/album/detail/dynamic`,
    { id: realId },
    cookie
  );
}

export async function getArtistDynamicDetail(id: string, cookie: string = "") {
  const realId = id.replace(/^(neartist_|ne_artist_)/, "");
  return requestWeapi(
    `${BASE_URL}/weapi/artist/detail/dynamic`,
    { id: realId },
    cookie
  );
}

export async function getArtistSongs(
  id: string,
  limit: number = 50,
  offset: number = 0,
  order: string = "hot",
  cookie: string = ""
) {
  const realId = id.replace(/^(neartist_|ne_artist_)/, "");
  return requestWeapi<{ songs: SongDetail[]; total: number; more: boolean }>(
    `${BASE_URL}/weapi/v1/artist/songs`,
    { id: realId, limit, offset, order, total: true },
    cookie
  );
}

export async function getArtistAlbums(
  id: string,
  limit: number = 30,
  offset: number = 0,
  cookie: string = ""
) {
  const realId = id.replace(/^(neartist_|ne_artist_)/, "");
  return requestWeapi(
    `${BASE_URL}/weapi/artist/albums/${realId}`,
    { limit, offset, total: true },
    cookie
  );
}

export async function getSubscribedAlbums(
  limit: number = 25,
  offset: number = 0,
  cookie: string = ""
) {
  return requestWeapi(
    `${BASE_URL}/weapi/album/sublist`,
    { limit, offset, total: true },
    cookie
  );
}

export async function getSubscribedArtists(
  limit: number = 25,
  offset: number = 0,
  cookie: string = ""
) {
  return requestWeapi(
    `${BASE_URL}/weapi/artist/sublist`,
    { limit, offset, total: true },
    cookie
  );
}

export async function searchSuggest(keyword: string, cookie: string = "") {
  return requestWeapi(
    `${BASE_URL}/weapi/search/suggest/web`,
    { s: keyword },
    cookie
  );
}

export async function getHotComments(
  id: string,
  limit: number = 20,
  offset: number = 0,
  cookie: string = ""
) {
  const realId = id.replace(/^(netrack_|ne_track_)/, "");
  const rid = `R_SO_4_${realId}`;

  return requestWeapi(
    `${BASE_URL}/weapi/v1/resource/hotcomments/${rid}`,
    { rid, limit, offset, beforeTime: 0 },
    cookie
  );
}

export async function getNewComments(
  id: string,
  pageNo: number = 1,
  pageSize: number = 20,
  sortType: number = 2,
  cursor: string | number = 0,
  cookie: string = ""
) {
  const realId = id.replace(/^(netrack_|ne_track_)/, "");

  return requestWeapi(
    `${BASE_URL}/weapi/comment/new`,
    {
      type: 0,
      id: realId,
      sortType,
      cursor,
      pageSize,
      pageNo,
    },
    cookie
  );
}

export async function getMusicComments(
  id: string,
  limit: number = 20,
  offset: number = 0,
  cookie: string = ""
) {
  return getHotComments(id, limit, offset, cookie);
}

export function resolveUrl(url: string): ResolveUrlResult | null {
  let result: ResolveUrlResult | null = null;
  let id: string;

  url = url.replace(
    "music.163.com/#/discover/toplist?",
    "music.163.com/#/playlist?"
  );
  url = url.replace("music.163.com/#/my/m/music/", "music.163.com/");
  url = url.replace("music.163.com/#/m/", "music.163.com/");
  url = url.replace("music.163.com/#/", "music.163.com/");

  const getParameterByName = (name: string, url: string) => {
    if (!url) url = "";
    name = name.replace(/[[\]]/g, "$&");
    const regex = new RegExp("[?&]" + name + "(=([^&#]*)|&|#|$)");
    const results = regex.exec(url);
    if (!results || !results[2]) return "";
    return decodeURIComponent(results[2].replace(/\+/g, " "));
  };

  if (url.search("//music.163.com/playlist") !== -1) {
    const match = /\/\/music.163.com\/playlist\/([0-9]+)/.exec(url);
    id = match ? match[1] : getParameterByName("id", url);
    if (id) result = { type: "playlist", id: `neplaylist_${id}` };
  } else if (url.search("//music.163.com/artist") !== -1) {
    const match = /\/\/music.163.com\/artist\?id=([0-9]+)/.exec(url);
    id = match ? match[1] : getParameterByName("id", url);
    if (id) result = { type: "artist", id: `neartist_${id}` };
  } else if (url.search("//music.163.com/album") !== -1) {
    const match = /\/\/music.163.com\/album\/([0-9]+)/.exec(url);
    id = match ? match[1] : getParameterByName("id", url);
    if (id) result = { type: "album", id: `nealbum_${id}` };
  } else if (url.search("//music.163.com/song") !== -1) {
    const match = /\/\/music.163.com\/song\/([0-9]+)/.exec(url);
    id = match ? match[1] : getParameterByName("id", url);
    if (id) result = { type: "song", id: `netrack_${id}` };
  }

  return result;
}

export const toggleSubArtist = async (
  id: string,
  shouldSub: boolean,
  cookie: string = ""
) => {
  const realId = id.replace(/^(neartist_|ne_artist_)/, "");
  const action = shouldSub ? "sub" : "unsub";
  return requestWeapi<{ code: number; message?: string }>(
    `${BASE_URL}/weapi/artist/${action}`,
    { artistId: realId, artistIds: [realId] }, // !  TODO:当前收藏歌手会报 250 系统错误, 暂时无法使用
    cookie
  );
};

export const toggleSubAlbum = async (
  id: string,
  shouldSub: boolean,
  cookie: string = ""
) => {
  const realId = id.replace(/^(nealbum_|ne_album_)/, "");
  const action = shouldSub ? "sub" : "unsub";
  return requestWeapi<{ code: number; message?: string }>(
    `${BASE_URL}/weapi/album/${action}`,
    { id: realId, t: shouldSub ? 1 : 0 },
    cookie
  );
};

export const toggleSubPlaylist = async (
  id: string,
  shouldSub: boolean,
  cookie: string = ""
) => {
  const realId = id.replace(/^(neplaylist_|ne_playlist_)/, "");
  return requestWeapi<{ code: number; message?: string }>(
    `${BASE_URL}/weapi/playlist/subscribe`,
    { id: realId, t: shouldSub ? 1 : 2 },
    cookie
  );
};

export const convertSongToMusicTrack = (song: any) => {
  const artists = song.ar || song.artists || [];
  const album = song.al || song.album || {};
  const songId = String(song.id || "");

  return {
    id: songId,
    name: song.name || "",
    artist: artists.map((a: { name: string }) => a.name),
    album: album.name || "",
    pic_id: album.picUrl || songId,
    url_id: songId,
    lyric_id: songId,
    source: "_netease" as const,
  };
};
