import type {
  AlbumDetail,
  AlbumDynamicDetail,
  ArtistDetail,
  ArtistAlbum,
  ArtistItem,
  NeteasePrivilege,
  PlaylistDetail,
  PlaylistDynamicDetail,
  RawNeteaseResponse,
  RawQrKeyData,
  RecommendPlaylist,
  ResolveUrlResult,
  SongDetail,
  Toplist,
  UserPlaylist,
  UserProfile,
  SearchSuggestResult,
  NeteaseCommentResult,
  NeteaseNewCommentResult,
} from "./netease-raw-types";
import type {
  MarketPlaylist,
  NeteaseSong,
  QrStatusResult,
} from "./netease-models";
import {
  toMarketPlaylistFromRecommend,
  toMarketPlaylistFromToplist,
  toMarketPlaylistFromUserPlaylist,
  unwrapQrKey,
  unwrapRecommendResult,
} from "./netease-normalize";
import type { MusicTrack } from "@/types/music";
import { clearDataCache } from "@/lib/utils/cache";
import { useNeteaseStore } from "@/store/netease-store";
import { useUrlCacheStore } from "@/store/url-cache-store";
import { clearMarketSession } from "@/store/session/market-session";
import { logger } from "@/lib/logger";
import { normalizePersistableResourceUrl } from "@shared/utils/url";

const NETEASE_API_PREFIX = "/music-api/netease";
const NETWORK_TIMEOUT_MS = 12000;
const PENDING_LOGOUT_KEY = "otter_netease_pending_logout";

type NeteaseEnvelope<T> = { data: T };

function normalizeArtistItemForClient(artist: ArtistItem): ArtistItem {
  return {
    id: artist.id,
    name: artist.name,
    picUrl: normalizePersistableResourceUrl(artist.picUrl),
    albumSize: artist.albumSize,
  };
}

function normalizeArtistAlbumForClient(album: ArtistAlbum): ArtistAlbum {
  const normalized: ArtistAlbum = {
    id: album.id,
    name: album.name,
    picUrl: normalizePersistableResourceUrl(album.picUrl),
    publishTime: album.publishTime,
    size: album.size,
  };
  if (album.type !== undefined) normalized.type = album.type;
  if (album.artist) {
    normalized.artist = normalizeArtistItemForClient(album.artist);
  }
  return normalized;
}

function throwIfNeteaseRequestAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw Object.assign(new Error("NETEASE_REQUEST_ABORTED"), {
    name: "AbortError",
  });
}

function hasPendingLogout(): boolean {
  try {
    return localStorage.getItem(PENDING_LOGOUT_KEY) === "1";
  } catch {
    return false;
  }
}

function setPendingLogout(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(PENDING_LOGOUT_KEY, "1");
    else localStorage.removeItem(PENDING_LOGOUT_KEY);
  } catch {
    // Storage may be unavailable; the server request still remains authoritative.
  }
}

async function clearSessionBoundClientCaches(): Promise<void> {
  const results = await Promise.allSettled([
    clearMarketSession(),
    useUrlCacheStore.getState().clear(),
    clearDataCache(),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    // Do not let a best-effort browser storage failure prevent authoritative
    // server logout or obscure the original 401 response.
    logger.warn("NetEase", "Session cache cleanup was incomplete");
  }
}

/**
 * Browser-only NetEase transport.
 *
 * Account credentials live exclusively in the server-side session. Keeping the
 * route prefix here (rather than accepting a URL from callers) also guarantees
 * that this module cannot silently fall back to a direct third-party request.
 */
async function fetchNeteaseApi<T>(
  path: `/${string}`,
  body?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (signal?.aborted) onCallerAbort();
  else signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = window.setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

  try {
    throwIfNeteaseRequestAborted(controller.signal);
    const response = await fetch(`${NETEASE_API_PREFIX}${path}`, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    });
    throwIfNeteaseRequestAborted(controller.signal);

    if (!response.ok) {
      const errorPayload = (await response.json().catch(() => ({}))) as {
        error?: unknown;
      };
      throwIfNeteaseRequestAborted(controller.signal);
      if (response.status === 401) {
        useNeteaseStore.getState().clearSession();
        await clearSessionBoundClientCaches();
      }
      const message =
        typeof errorPayload.error === "string"
          ? errorPayload.error
          : `NetEase API Error: ${response.status}`;
      throw new Error(message);
    }

    const payload = (await response.json()) as T;
    throwIfNeteaseRequestAborted(controller.signal);
    return payload;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

export async function getSongUrl(
  id: string,
  br: number = 999000,
  _legacyCredential: string = "",
  signal?: AbortSignal
): Promise<
  NeteaseEnvelope<{
    data: { url: string; br: number; size: number; freeTrialInfo?: unknown }[];
  }>
> {
  const realId = id.replace(/^(netrack_|ne_track_)/, "");
  return fetchNeteaseApi("/song-url", { id: realId, br }, signal);
}

export const getQrKey = async (signal?: AbortSignal): Promise<string> => {
  const response = await fetchNeteaseApi<RawNeteaseResponse<RawQrKeyData>>(
    "/login/qr/key",
    undefined,
    signal
  );
  return unwrapQrKey(response);
};

export const checkQrStatus = async (
  key: string,
  signal?: AbortSignal
): Promise<QrStatusResult> => {
  const result = await fetchNeteaseApi<QrStatusResult>(
    "/login/qr/check",
    { key },
    signal
  );
  if (result.code === 803 || result.authenticated) setPendingLogout(false);
  return result;
};

export const loginCellphone = async (
  phone: string,
  password: string,
  signal?: AbortSignal
): Promise<UserProfile> => {
  const result = await fetchNeteaseApi<{
    authenticated: true;
    profile: UserProfile;
  }>("/login/cellphone", { phone, password }, signal);
  setPendingLogout(false);
  return result.profile;
};

export const getNeteaseSession = async (
  signal?: AbortSignal
): Promise<UserProfile | null> => {
  if (hasPendingLogout()) {
    await logoutNeteaseSession(signal);
    return null;
  }

  const response = await fetchNeteaseApi<{
    authenticated: boolean;
    profile?: UserProfile;
  }>("/session/me", undefined, signal);
  return response.authenticated ? (response.profile ?? null) : null;
};

export const logoutNeteaseSession = async (
  signal?: AbortSignal
): Promise<void> => {
  setPendingLogout(true);
  // Clear first so an aborted or superseded logout cannot perform a late
  // client-state write over a newly established account owner.
  await clearSessionBoundClientCaches();
  await fetchNeteaseApi<{ authenticated: false }>("/logout", {}, signal);
  // The server has now authoritatively revoked the HttpOnly session. Clear
  // the local owner before the final cache pass so in-flight Mine requests
  // cannot repopulate account data between teardown and the caller settling.
  useNeteaseStore.getState().clearSession();
  await clearSessionBoundClientCaches();
  setPendingLogout(false);
};

export const getUserPlaylists = async (
  _userId: string,
  _legacyCredential: string = "",
  signal?: AbortSignal
): Promise<MarketPlaylist[]> => {
  const all: MarketPlaylist[] = [];
  const pageSize = 100;
  let offset = 0;

  // NetEase accounts can contain more than one API page. Keep this helper's
  // historical array return type while honoring the upstream pagination
  // contract instead of silently truncating at a fixed first page.
  for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
    const response = await fetchNeteaseApi<{
      playlist: UserPlaylist[];
      code: number;
      more?: boolean;
    }>("/user-playlists", { limit: pageSize, offset }, signal);
    if (response.code !== 200) {
      throw new Error(`NetEase user playlists error: ${response.code}`);
    }

    const page = Array.isArray(response.playlist) ? response.playlist : [];
    all.push(...page.map(toMarketPlaylistFromUserPlaylist));
    const hasMore = response.more ?? page.length >= pageSize;
    if (!hasMore) return all;
    if (page.length === 0) {
      throw new Error("NetEase user playlists returned an empty continuation");
    }
    offset += pageSize;
  }

  throw new Error("NetEase user playlists exceeded the pagination safety cap");
};

export const getRecommendPlaylists = async (
  _legacyCredential: string = "",
  signal?: AbortSignal
): Promise<MarketPlaylist[]> => {
  const response = await fetchNeteaseApi<{
    result?: RecommendPlaylist[];
    data?: { result?: RecommendPlaylist[] };
  }>("/recommend", {}, signal);
  return unwrapRecommendResult(response).map(toMarketPlaylistFromRecommend);
};

export const getPlaylistDetail = (
  playlistId: string,
  _legacyCredential: string = ""
) => {
  const realId = playlistId.replace(/^(neplaylist_|ne_playlist_)/, "");
  return fetchNeteaseApi<PlaylistDetail>("/playlist", { playlistId: realId });
};

export const getPlaylistDynamicDetail = async (
  id: string,
  _legacyCredential: string = ""
): Promise<PlaylistDynamicDetail | null> => {
  try {
    const response = await fetchNeteaseApi<
      NeteaseEnvelope<PlaylistDynamicDetail>
    >("/playlist/dynamic", { id });
    return response.data ?? null;
  } catch (error) {
    logger.warn(
      "NetEase",
      "getPlaylistDynamicDetail failed",
      error instanceof Error ? error : undefined
    );
    return null;
  }
};

export async function search(
  keyword: string,
  type: number = 1,
  page: number = 1,
  limit: number = 20,
  _legacyCredential: string = "",
  signal?: AbortSignal
) {
  return fetchNeteaseApi<{
    data: {
      result: {
        songs?: NeteaseSong[];
        songCount?: number;
        hasMore?: boolean;
        playlists?: UserPlaylist[];
        playlistCount?: number;
      };
      code: number;
    };
  }>("/search", { keyword, type, page, limit }, signal);
}

export async function searchPlaylists(
  keyword: string,
  page: number = 1,
  limit: number = 30,
  _legacyCredential: string = ""
): Promise<MarketPlaylist[]> {
  const response = await search(keyword, 1000, page, limit);
  return (response.data?.result?.playlists ?? []).map(
    toMarketPlaylistFromUserPlaylist
  );
}

export const getLyric = (
  id: string,
  _legacyCredential: string = "",
  signal?: AbortSignal
) => {
  const realId = id.replace(/^(netrack_|ne_track_)/, "");
  return fetchNeteaseApi<
    NeteaseEnvelope<{
      lrc: { lyric: string };
      tlyric: { lyric: string };
    }>
  >("/lyric", { id: realId }, signal);
};

export const getSongDetail = (id: string, _legacyCredential: string = "") => {
  const realId = id.replace(/^(netrack_|ne_track_)/, "");
  return fetchNeteaseApi<SongDetail>("/song-detail", { id: realId });
};

export const getToplist = async (
  _legacyCredential: string = ""
): Promise<MarketPlaylist[]> => {
  const response = await fetchNeteaseApi<NeteaseEnvelope<{ list: Toplist[] }>>(
    "/toplist",
    {}
  );
  return (response.data?.list ?? []).map(toMarketPlaylistFromToplist);
};

export const getAlbum = async (id: string, _legacyCredential: string = "") => {
  const realId = id.replace(/^(nealbum_|ne_album_)/, "");
  const response = await fetchNeteaseApi<NeteaseEnvelope<AlbumDetail>>(
    "/album",
    { id: realId }
  );
  return response.data;
};

export const getAlbumDynamicDetail = async (
  id: string,
  _legacyCredential: string = ""
): Promise<AlbumDynamicDetail | null> => {
  try {
    const response = await fetchNeteaseApi<NeteaseEnvelope<AlbumDynamicDetail>>(
      "/album/dynamic",
      { id }
    );
    return response.data ?? null;
  } catch (error) {
    logger.warn(
      "NetEase",
      "getAlbumDynamicDetail failed",
      error instanceof Error ? error : undefined
    );
    return null;
  }
};

export const getArtist = async (id: string, _legacyCredential: string = "") => {
  const realId = id.replace(/^(neartist_|ne_artist_)/, "");
  const response = await fetchNeteaseApi<NeteaseEnvelope<ArtistDetail>>(
    "/artist",
    { id: realId }
  );
  return response.data;
};

export const getArtistDynamicDetail = async (
  id: string,
  _legacyCredential: string = ""
): Promise<Record<string, unknown> | null> => {
  try {
    const response = await fetchNeteaseApi<
      NeteaseEnvelope<Record<string, unknown>>
    >("/artist/dynamic", { id });
    return response.data ?? null;
  } catch (error) {
    logger.warn(
      "NetEase",
      "getArtistDynamicDetail failed",
      error instanceof Error ? error : undefined
    );
    return null;
  }
};

export const getArtistSongs = async (
  id: string,
  limit: number = 50,
  offset: number = 0,
  order: string = "hot",
  _legacyCredential: string = ""
) => {
  const realId = id.replace(/^(neartist_|ne_artist_)/, "");
  const response = await fetchNeteaseApi<
    NeteaseEnvelope<{
      songs: SongDetail[];
      total: number;
      more: boolean;
    }>
  >("/artist/songs", { id: realId, limit, offset, order });
  return response.data;
};

export const getArtistAlbums = async (
  id: string,
  limit: number = 30,
  offset: number = 0,
  _legacyCredential: string = "",
  signal?: AbortSignal
) => {
  const realId = id.replace(/^(neartist_|ne_artist_)/, "");
  const response = await fetchNeteaseApi<
    NeteaseEnvelope<{ hotAlbums: ArtistAlbum[]; more: boolean }>
  >("/artist/albums", { id: realId, limit, offset }, signal);
  return {
    hotAlbums: (response.data?.hotAlbums ?? []).map(
      normalizeArtistAlbumForClient
    ),
    more: Boolean(response.data?.more),
  };
};

export const getSubscribedAlbums = async (
  limit: number = 25,
  offset: number = 0,
  _legacyCredential: string = "",
  signal?: AbortSignal
): Promise<ArtistAlbum[]> => {
  try {
    const response = await fetchNeteaseApi<
      NeteaseEnvelope<{ data?: ArtistAlbum[] }>
    >("/album/sublist", { limit, offset }, signal);
    return (response.data?.data ?? []).map(normalizeArtistAlbumForClient);
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw error;
    }
    logger.warn(
      "NetEase",
      "getSubscribedAlbums failed",
      error instanceof Error ? error : undefined
    );
    return [];
  }
};

export const getSubscribedArtists = async (
  limit: number = 25,
  offset: number = 0,
  _legacyCredential: string = ""
): Promise<ArtistItem[]> => {
  try {
    const response = await fetchNeteaseApi<
      NeteaseEnvelope<{ data?: ArtistItem[] }>
    >("/artist/sublist", { limit, offset });
    return response.data?.data ?? [];
  } catch (error) {
    logger.warn(
      "NetEase",
      "getSubscribedArtists failed",
      error instanceof Error ? error : undefined
    );
    return [];
  }
};

export const toggleSubArtist = async (
  id: string,
  shouldSub: boolean,
  _legacyCredential: string = ""
) =>
  fetchNeteaseApi<
    NeteaseEnvelope<{ code: number; message?: string }> & {
      code?: number;
      message?: string;
    }
  >("/artist/sub", { id, shouldSub });

export const toggleSubAlbum = async (
  id: string,
  shouldSub: boolean,
  _legacyCredential: string = ""
) =>
  fetchNeteaseApi<
    NeteaseEnvelope<{ code: number; message?: string }> & {
      code?: number;
      message?: string;
    }
  >("/album/sub", { id, shouldSub });

export const toggleSubPlaylist = async (
  id: string,
  shouldSub: boolean,
  _legacyCredential: string = ""
) =>
  fetchNeteaseApi<
    NeteaseEnvelope<{ code: number; message?: string }> & {
      code?: number;
      message?: string;
    }
  >("/playlist/sub", { id, shouldSub });

export const getPlaylists = async (
  cat: string = "全部",
  order: string = "hot",
  limit: number = 30,
  offset: number = 0,
  _legacyCredential: string = ""
) => {
  const response = await fetchNeteaseApi<
    NeteaseEnvelope<{ playlists: UserPlaylist[] }>
  >("/playlists", { cat, order, limit, offset });
  return (response.data?.playlists ?? []).map(toMarketPlaylistFromUserPlaylist);
};

export const searchSuggest = async (
  keyword: string,
  _legacyCredential: string = ""
) => {
  const response = await fetchNeteaseApi<
    NeteaseEnvelope<{ result?: SearchSuggestResult }>
  >("/search/suggest", { keyword });
  return response.data?.result ?? {};
};

export const getHotComments = async (
  id: string,
  limit: number = 20,
  offset: number = 0,
  _legacyCredential: string = ""
) => {
  const realId = id.replace(/^(netrack_|ne_track_)/, "");
  const response = await fetchNeteaseApi<NeteaseEnvelope<NeteaseCommentResult>>(
    "/comments/hot",
    { id: realId, limit, offset }
  );
  return response.data;
};

export const getNewComments = async (
  id: string,
  pageNo: number = 1,
  pageSize: number = 20,
  sortType: number = 2,
  cursor: string | number = 0,
  _legacyCredential: string = ""
) => {
  const realId = id.replace(/^(netrack_|ne_track_)/, "");
  const response = await fetchNeteaseApi<
    NeteaseEnvelope<NeteaseNewCommentResult>
  >("/comments/new", {
    id: realId,
    pageNo,
    pageSize,
    sortType,
    cursor,
  });
  return response.data?.data ?? null;
};

export const getMusicComments = (
  id: string,
  limit: number = 20,
  offset: number = 0,
  _legacyCredential: string = ""
) => getHotComments(id, limit, offset);

export function resolveUrl(urlStr: string): ResolveUrlResult | null {
  try {
    const normalized = urlStr.replace(
      /music\.163\.com\/(#\/)?(discover\/toplist\?|my\/m\/music\/|m\/|)/g,
      "music.163.com/"
    );
    const url = new URL(
      normalized.startsWith("http") ? normalized : `https://${normalized}`
    );
    const id = url.searchParams.get("id") || url.pathname.split("/").pop();

    if (!id) return null;
    if (url.pathname.includes("/playlist"))
      return { type: "playlist", id: `neplaylist_${id}` };
    if (url.pathname.includes("/artist"))
      return { type: "artist", id: `neartist_${id}` };
    if (url.pathname.includes("/album"))
      return { type: "album", id: `nealbum_${id}` };
    if (url.pathname.includes("/song"))
      return { type: "song", id: `netrack_${id}` };
  } catch {
    // Ignore invalid user input.
  }
  return null;
}

export const convertSongToMusicTrack = (
  song: NeteaseSong,
  includePrivilege: boolean = true
): MusicTrack => {
  const artists = song.ar || song.artists || [];
  const album = song.al || song.album || {};
  const songId = String(song.id);

  let privilege: NeteasePrivilege | undefined;
  if (includePrivilege) {
    privilege = song.privilege;
    if (!privilege && song.fee !== undefined) {
      privilege = {
        id: Number(song.id),
        fee: song.fee,
        payed: 0,
        st: song.st ?? song.status ?? 0,
        pl: song.fee === 1 || song.fee === 4 ? 0 : 128000,
        maxbr: 999000,
        plLevel: "standard",
        freeTrialPrivilege: { remainTime: 0 },
      };
    }
  }

  return {
    id: songId,
    name: song.name || "",
    artist: artists.map((artist: { name: string }) => artist.name),
    album: album.name || "",
    pic_id: normalizePersistableResourceUrl(album.picUrl) || songId,
    url_id: songId,
    lyric_id: songId,
    source: "_netease",
    privilege,
    artist_ids: artists.map((artist: { id?: string | number }) =>
      String(artist.id || "")
    ),
    album_id: String(album.id || ""),
    duration:
      Number.isFinite(song.dt) && (song.dt ?? 0) > 0
        ? song.dt! / 1000
        : undefined,
  };
};
