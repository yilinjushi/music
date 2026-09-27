import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../../types/hono";
import {
  createNeteaseSession,
  deleteNeteaseSession,
  NETEASE_SESSION_COOKIE,
  readNeteaseSession,
  renewNeteaseSession,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
} from "../../utils/netease-session";
import {
  getSongUrl,
  proxyNeteaseAudio,
  getUserPlaylists,
  getPlaylistDetail,
  getPlaylistDynamicDetail,
  getQrKey,
  checkQrStatus,
  loginCellphone,
  getMyInfo,
  getRecommendPlaylists,
  search,
  getLyric,
  getSongDetail,
  getToplist,
  getAlbum,
  getAlbumDynamicDetail,
  getArtist,
  getArtistDynamicDetail,
  getArtistSongs,
  getArtistAlbums,
  getSubscribedAlbums,
  getSubscribedArtists,
  getPlaylists,
  searchSuggest,
  getHotComments,
  getNewComments,
  getMusicComments,
  resolveUrl,
  toggleSubArtist,
  toggleSubAlbum,
  toggleSubPlaylist,
} from "../../utils/music/netease-api";
import { isValidAudioRange } from "../../utils/proxy/audio";
import {
  containsControlCharacter,
  normalizePersistableResourceUrl,
} from "@otter-music/shared";
import {
  checkFixedWindowRateLimit,
  requestClientId,
} from "../../utils/request-rate-limit";
import { isAllowedRequestOrigin } from "../../middleware/cors";
import {
  classifySensitiveData,
  classifySensitiveString,
  containsSensitiveData,
  containsSensitiveSearchParams,
  containsSensitiveString,
  isCapabilityFieldName,
  isSensitiveFieldName,
} from "../../utils/cache";

export const neteaseRoutes = new Hono<{ Bindings: Env }>();

type NeteaseContext = Context<{ Bindings: Env }>;

type NeteaseRecord = Record<string, unknown>;

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";
const SAFE_UPSTREAM_ERROR = "NetEase upstream failed";
const SAFE_AUDIO_UPSTREAM_ERROR = "NetEase audio upstream failed";
const REDACTED_VALUE = "[redacted]";
const SAFE_GENERIC_MESSAGE = "NetEase response received";
const SAFE_GENERIC_ERROR = "NetEase request failed";
const SAFE_MESSAGE_VALUES = new Set([
  "QR code expired",
  "Waiting for scan",
  "Waiting for confirmation",
  "Login successful",
  "QR login pending",
]);
const SAFE_ERROR_VALUES = new Set([
  SAFE_UPSTREAM_ERROR,
  SAFE_AUDIO_UPSTREAM_ERROR,
  "Too many login requests",
  "Login rate limiter unavailable",
  "Cross-site request rejected",
  "Client-supplied NetEase credentials are not accepted",
  "Invalid QR key",
  "Invalid cellphone login",
  "NetEase login rejected",
  "NetEase profile unavailable",
  "Unauthorized",
  "ID required",
  "Invalid audio request",
  "Too many audio requests",
  "Audio rate limiter unavailable",
  "Invalid URL",
  "Keyword required",
  "Invalid request",
  "Invalid pagination",
  "Invalid playlist ID",
  "Too many playlist requests",
  "Playlist rate limiter unavailable",
]);
const NETEASE_AUDIO_ID = /^\d{1,20}$/;
const NETEASE_AUDIO_BITRATES = new Set([128000, 192000, 320000, 999000]);
const NETEASE_TRACK_ID = /^(?:(?:netrack|ne_track)_)?\d{1,20}$/;
const NETEASE_PLAYLIST_ID = /^(?:(?:neplaylist|ne_playlist)_)?\d{1,20}$/;
const NETEASE_PLAYLIST_PAGE_SIZE = 100;
const NETEASE_PLAYLIST_MAX_TOTAL_TRACKS = 20_000;
const NETEASE_ALBUM_ID = /^(?:(?:nealbum|ne_album)_)?\d{1,20}$/;
const NETEASE_ARTIST_ID = /^(?:(?:neartist|ne_artist)_)?\d{1,20}$/;
const ALLOWED_FETCH_SITES = new Set(["same-origin", "same-site"]);
const CELLPHONE_PATTERN = /^1\d{10}$/;

async function readStrictJsonObject(
  c: NeteaseContext,
  allowedKeys: ReadonlySet<string>
): Promise<Record<string, unknown> | null> {
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return Object.keys(record).every((key) => allowedKeys.has(key))
    ? record
    : null;
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isSafeKeyword(value: unknown, maximum = 100): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maximum &&
    !containsControlCharacter(value)
  );
}

function rejectsPublicRequestSource(c: NeteaseContext): boolean {
  const fetchSite = c.req.header("Sec-Fetch-Site")?.toLowerCase();
  const origin = c.req.header("Origin");
  if (!fetchSite || !ALLOWED_FETCH_SITES.has(fetchSite) || !origin) return true;
  return !isAllowedRequestOrigin(c.req.url, origin, c.env.APP_ORIGIN);
}

function containsClientCredential(value: unknown): boolean {
  return containsSensitiveData(value);
}

function isCellphoneLoginBody(value: unknown): value is {
  phone: string;
  password: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    CELLPHONE_PATTERN.test(typeof body.phone === "string" ? body.phone : "") &&
    typeof body.password === "string" &&
    body.password.length >= 1 &&
    body.password.length <= 256 &&
    !containsControlCharacter(body.password)
  );
}

function normalizeSessionProfile(value: unknown): {
  userId: number;
  nickname: string;
  avatarUrl: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const profile = value as Record<string, unknown>;
  if (
    typeof profile.userId !== "number" ||
    !Number.isSafeInteger(profile.userId) ||
    profile.userId < 0 ||
    typeof profile.nickname !== "string" ||
    profile.nickname.length > 256 ||
    containsSensitiveData(profile.nickname) ||
    typeof profile.avatarUrl !== "string"
  ) {
    return null;
  }
  const avatarUrl = normalizePersistableResourceUrl(profile.avatarUrl);
  if (profile.avatarUrl.trim() && !avatarUrl) return null;
  return { userId: profile.userId, nickname: profile.nickname, avatarUrl };
}

function safeNeteaseEntity(value: unknown): NeteaseRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as NeteaseRecord;
  const id = record.id;
  const name = record.name;
  if (
    (typeof id !== "number" && typeof id !== "string") ||
    typeof name !== "string"
  ) {
    return null;
  }
  return { id, name };
}

function sanitizePlaylistDetailForClient(value: unknown): NeteaseRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const playlist = value as NeteaseRecord;
  const id = playlist.id;
  const name = playlist.name;
  const tracks = playlist.tracks;
  if (
    (typeof id !== "number" && typeof id !== "string") ||
    typeof name !== "string" ||
    !Array.isArray(tracks)
  ) {
    return null;
  }

  const safeTracks = tracks.map((value) => {
    const song = value as NeteaseRecord;
    const entity = safeNeteaseEntity(song);
    const artists = Array.isArray(song.ar)
      ? song.ar.map(safeNeteaseEntity).filter((item) => item !== null)
      : [];
    const album = safeNeteaseEntity(song.al);
    if (!entity || !album) return null;

    const result: NeteaseRecord = {
      ...entity,
      ar: artists,
      al: {
        ...album,
        picUrl: normalizePersistableResourceUrl(
          typeof (song.al as NeteaseRecord).picUrl === "string"
            ? ((song.al as NeteaseRecord).picUrl as string)
            : undefined
        ),
      },
      dt: song.dt,
      fee: song.fee,
      st: song.st,
    };
    if (song.privilege && typeof song.privilege === "object") {
      const privilege = song.privilege as NeteaseRecord;
      result.privilege = {
        id: privilege.id,
        fee: privilege.fee,
        payed: privilege.payed,
        st: privilege.st,
        pl: privilege.pl,
        maxbr: privilege.maxbr,
        plLevel: privilege.plLevel,
        freeTrialPrivilege: {},
      };
    }
    return result;
  });
  if (safeTracks.some((track) => track === null)) return null;

  const creator = normalizeSessionProfile(playlist.creator);
  const result: NeteaseRecord = {
    id,
    name,
    coverImgUrl: normalizePersistableResourceUrl(
      typeof playlist.coverImgUrl === "string"
        ? playlist.coverImgUrl
        : undefined
    ),
    description:
      typeof playlist.description === "string" ? playlist.description : "",
    trackCount:
      typeof playlist.trackCount === "number"
        ? playlist.trackCount
        : safeTracks.length,
    playCount: typeof playlist.playCount === "number" ? playlist.playCount : 0,
    tracks: safeTracks,
    trackIds: safeTracks.map((track) => ({ id: track!.id })),
    creator: creator ?? undefined,
  };
  if (
    typeof playlist.nextOffset === "number" &&
    Number.isSafeInteger(playlist.nextOffset) &&
    playlist.nextOffset >= 0 &&
    playlist.nextOffset <= NETEASE_PLAYLIST_MAX_TOTAL_TRACKS
  ) {
    result.nextOffset = playlist.nextOffset;
  }
  if (typeof playlist.hasMore === "boolean") {
    result.hasMore = playlist.hasMore;
  }
  return result;
}

function stripClientCredentialFields(
  value: unknown,
  allowCapabilities = false
): unknown {
  if (typeof value === "string") {
    const classification = classifySensitiveString(value);
    return classification.hasCredential ||
      (classification.hasCapability && !allowCapabilities)
      ? REDACTED_VALUE
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((child) =>
      stripClientCredentialFields(child, allowCapabilities)
    );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !isSensitiveFieldName(key) ||
          (allowCapabilities && isCapabilityFieldName(key))
      )
      .map(([key, child]) => {
        const normalizedKey = key.toLowerCase();
        if (normalizedKey === "message" && typeof child === "string") {
          return [
            key,
            SAFE_MESSAGE_VALUES.has(child) ? child : SAFE_GENERIC_MESSAGE,
          ];
        }
        if (normalizedKey === "error" && typeof child === "string") {
          return [
            key,
            SAFE_ERROR_VALUES.has(child) ? child : SAFE_GENERIC_ERROR,
          ];
        }
        return [key, stripClientCredentialFields(child, allowCapabilities)];
      })
  );
}

function privateJson(
  c: NeteaseContext,
  value: unknown,
  status: ContentfulStatusCode = 200
) {
  c.header("Cache-Control", PRIVATE_CACHE_CONTROL);
  c.header("Pragma", "no-cache");
  return c.json(stripClientCredentialFields(value), status);
}

function upstreamFailure(c: NeteaseContext) {
  return privateJson(c, { error: SAFE_UPSTREAM_ERROR }, 502);
}

function qrStatusMessage(code: number): string {
  if (code === 800) return "QR code expired";
  if (code === 801) return "Waiting for scan";
  if (code === 802) return "Waiting for confirmation";
  if (code === 803) return "Login successful";
  return "QR login pending";
}

async function currentSession(c: NeteaseContext) {
  return readNeteaseSession(c.env, c.req.header("Cookie"));
}

async function loginRateLimit(
  c: NeteaseContext,
  scope: string,
  limit: number
): Promise<Response | null> {
  try {
    const rate = await checkFixedWindowRateLimit(
      c.env.oh_file_url,
      scope,
      requestClientId(c.req.raw.headers),
      limit,
      60
    );
    c.header("X-RateLimit-Remaining", String(rate.remaining));
    if (rate.allowed) return null;
    c.header("Retry-After", String(rate.retryAfterSeconds));
    return privateJson(c, { error: "Too many login requests" }, 429);
  } catch {
    return privateJson(c, { error: "Login rate limiter unavailable" }, 503);
  }
}

function normalizeAudioId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.replace(/^(netrack_|ne_track_)/, "");
  return NETEASE_AUDIO_ID.test(id) ? id : null;
}

function normalizeAudioBitrate(value: unknown): number | null {
  if (value === undefined) return 999000;
  return typeof value === "number" && NETEASE_AUDIO_BITRATES.has(value)
    ? value
    : null;
}

function neteaseAudioPath(id: string, br: number): string {
  return `/music-api/netease/audio?${new URLSearchParams({
    id,
    br: String(br),
  }).toString()}`;
}

async function audioRateLimit(c: NeteaseContext): Promise<Response | null> {
  try {
    const rate = await checkFixedWindowRateLimit(
      c.env.oh_file_url,
      "netease-audio",
      requestClientId(c.req.raw.headers),
      120,
      60
    );
    c.header("X-RateLimit-Remaining", String(rate.remaining));
    if (rate.allowed) return null;
    c.header("Retry-After", String(rate.retryAfterSeconds));
    return privateJson(c, { error: "Too many audio requests" }, 429);
  } catch {
    return privateJson(c, { error: "Audio rate limiter unavailable" }, 503);
  }
}

async function playlistRateLimit(c: NeteaseContext): Promise<Response | null> {
  try {
    const rate = await checkFixedWindowRateLimit(
      c.env.oh_file_url,
      "netease-playlist",
      requestClientId(c.req.raw.headers),
      30,
      60
    );
    c.header("X-RateLimit-Remaining", String(rate.remaining));
    if (rate.allowed) return null;
    c.header("Retry-After", String(rate.retryAfterSeconds));
    return privateJson(c, { error: "Too many playlist requests" }, 429);
  } catch {
    return privateJson(c, { error: "Playlist rate limiter unavailable" }, 503);
  }
}

neteaseRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", PRIVATE_CACHE_CONTROL);
  c.header("Pragma", "no-cache");

  if (c.req.header("Sec-Fetch-Site") === "cross-site") {
    return privateJson(c, { error: "Cross-site request rejected" }, 403);
  }

  const requestUrl = new URL(c.req.url);
  const rawCookie = c.req.header("Cookie") || "";
  if (
    containsSensitiveSearchParams(requestUrl.searchParams) ||
    containsSensitiveString(rawCookie) ||
    c.req.header("Authorization") ||
    c.req.header("X-Real-Cookie") ||
    c.req.header("Proxy-Authorization")
  ) {
    return privateJson(
      c,
      { error: "Client-supplied NetEase credentials are not accepted" },
      400
    );
  }

  if (
    ["POST", "PUT", "PATCH"].includes(c.req.method) &&
    c.req.header("Content-Type")?.toLowerCase().includes("application/json")
  ) {
    const body = await c.req.json<unknown>().catch(() => null);
    const cellphoneLogin =
      c.req.path.endsWith("/login/cellphone") && isCellphoneLoginBody(body);
    if (!cellphoneLogin && containsClientCredential(body)) {
      return privateJson(
        c,
        { error: "Client-supplied NetEase credentials are not accepted" },
        400
      );
    }
  }

  await next();

  if (c.res.headers.get("Content-Type")?.includes("application/json")) {
    const payload = await c.res
      .clone()
      .json()
      .catch(() => null);
    if (payload !== null) {
      const capabilityResponse = c.req.path.endsWith("/song-url");
      if (capabilityResponse && classifySensitiveData(payload).hasCredential) {
        c.res = c.json({ error: SAFE_UPSTREAM_ERROR }, 502);
      } else {
        c.res = new Response(
          JSON.stringify(
            stripClientCredentialFields(payload, capabilityResponse)
          ),
          {
            status: c.res.status,
            statusText: c.res.statusText,
            headers: c.res.headers,
          }
        );
      }
    }
  }
});

neteaseRoutes.post("/login/cellphone", async (c) => {
  const limited = await loginRateLimit(c, "netease-cellphone-login", 5);
  if (limited) return limited;
  const body = await c.req.json<unknown>().catch(() => null);
  if (!isCellphoneLoginBody(body)) {
    return privateJson(c, { error: "Invalid cellphone login" }, 400);
  }

  try {
    const result = await loginCellphone(body.phone, body.password);
    if (result.data.code !== 200 || !result.cookie) {
      return privateJson(c, { error: "NetEase login rejected" }, 401);
    }
    const profile =
      normalizeSessionProfile(result.data.profile) ??
      normalizeSessionProfile((await getMyInfo(result.cookie)).data?.profile);
    if (!profile)
      return privateJson(c, { error: "NetEase profile unavailable" }, 502);

    const session = await createNeteaseSession(c.env, result.cookie, profile);
    c.header(
      "Set-Cookie",
      serializeSessionCookie(session.token, session.maxAge)
    );
    return privateJson(c, { authenticated: true, profile });
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 获取二维码登录所需的 key
 * @method GET
 * @path /login/qr/key
 * @returns {Promise<QrKeyResponse>}
 */
neteaseRoutes.get("/login/qr/key", async (c) => {
  const limited = await loginRateLimit(c, "netease-qr-key", 10);
  if (limited) return limited;
  try {
    const res = await getQrKey();
    return privateJson(c, res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 检查二维码登录状态
 * @method POST
 * @path /login/qr/check
 * @body {string} key - QR code key
 * @returns {Promise<QrCheckResponse>}
 */
neteaseRoutes.post("/login/qr/check", async (c) => {
  const limited = await loginRateLimit(c, "netease-qr-check", 90);
  if (limited) return limited;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const key = body?.key;
  if (
    !body ||
    Object.keys(body).some((name) => name !== "key") ||
    typeof key !== "string" ||
    !/^[A-Za-z0-9_-]{8,256}$/.test(key)
  ) {
    return privateJson(c, { error: "Invalid QR key" }, 400);
  }

  try {
    const res = await checkQrStatus(key);
    const status = res.data as {
      code: number;
      message?: string;
      cookie?: string;
    };

    if (status.code !== 803) {
      return privateJson(c, {
        code: status.code,
        message: qrStatusMessage(status.code),
      });
    }

    const credential = res.cookie || status.cookie || "";
    const account = await getMyInfo(credential);
    const profile = account.data?.profile;
    if (!profile) {
      return privateJson(c, { error: "NetEase profile unavailable" }, 502);
    }

    const safeProfile = normalizeSessionProfile(profile);
    if (!safeProfile) {
      return privateJson(c, { error: "NetEase profile unavailable" }, 502);
    }
    const session = await createNeteaseSession(c.env, credential, safeProfile);
    c.header(
      "Set-Cookie",
      serializeSessionCookie(session.token, session.maxAge)
    );
    return privateJson(c, {
      code: 803,
      message: qrStatusMessage(803),
      authenticated: true,
      profile: safeProfile,
    });
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.get("/session/me", async (c) => {
  const session = await currentSession(c);
  if (!session) {
    c.header("Set-Cookie", serializeExpiredSessionCookie());
    return privateJson(c, { authenticated: false }, 401);
  }
  const cookieHeader = c.req.header("Cookie");
  const renewedMaxAge = await renewNeteaseSession(c.env, cookieHeader).catch(
    () => null
  );
  const token = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${NETEASE_SESSION_COOKIE}=`))
    ?.slice(NETEASE_SESSION_COOKIE.length + 1);
  if (renewedMaxAge !== null && token) {
    c.header(
      "Set-Cookie",
      serializeSessionCookie(decodeURIComponent(token), renewedMaxAge)
    );
  }
  return privateJson(c, { authenticated: true, profile: session.profile });
});

const logoutHandler = async (c: NeteaseContext) => {
  await deleteNeteaseSession(c.env, c.req.header("Cookie"));
  c.header("Set-Cookie", serializeExpiredSessionCookie());
  return privateJson(c, { authenticated: false });
};

neteaseRoutes.post("/logout", logoutHandler);
neteaseRoutes.post("/session/logout", logoutHandler);

/**
 * 获取我的用户信息
 * @method POST
 * @path /my-info
 * @returns {Promise<{ profile: UserProfile }>}
 */
neteaseRoutes.post("/my-info", async (c) => {
  const session = await currentSession(c);
  if (!session) return privateJson(c, { error: "Unauthorized" }, 401);
  return privateJson(c, { profile: session.profile });
});

/**
 * 获取用户歌单
 * @method POST
 * @path /user-playlists
 * @returns {Promise<{ playlist: UserPlaylist[], code: number }>}
 */
neteaseRoutes.post("/user-playlists", async (c) => {
  const session = await currentSession(c);
  if (!session) return privateJson(c, { error: "Unauthorized" }, 401);
  const body = await readStrictJsonObject(c, new Set(["limit", "offset"]));
  if (!body) return privateJson(c, { error: "Invalid request" }, 400);
  const limit = body.limit ?? 100;
  const offset = body.offset ?? 0;
  if (
    !isIntegerInRange(limit, 1, 200) ||
    !isIntegerInRange(offset, 0, 10_000)
  ) {
    return privateJson(c, { error: "Invalid pagination" }, 400);
  }
  try {
    const res = await getUserPlaylists(
      String(session.profile.userId),
      session.credential,
      limit,
      offset
    );
    return privateJson(c, res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 获取歌单详情
 * @method POST
 * @path /playlist
 * @body {string} playlistId - Playlist ID
 * @returns {Promise<PlaylistDetail>}
 */
neteaseRoutes.post("/playlist", async (c) => {
  if (rejectsPublicRequestSource(c)) {
    return privateJson(c, { error: "Cross-site request rejected" }, 403);
  }
  const body = await readStrictJsonObject(
    c,
    new Set(["playlistId", "offset", "limit"])
  );
  const playlistId = body?.playlistId;
  if (typeof playlistId !== "string" || !NETEASE_PLAYLIST_ID.test(playlistId)) {
    return privateJson(c, { error: "Invalid playlist ID" }, 400);
  }
  const offset = body?.offset ?? 0;
  const limit = body?.limit ?? NETEASE_PLAYLIST_PAGE_SIZE;
  if (
    !isIntegerInRange(offset, 0, NETEASE_PLAYLIST_MAX_TOTAL_TRACKS) ||
    !isIntegerInRange(limit, 1, 500)
  ) {
    return privateJson(c, { error: "Invalid pagination" }, 400);
  }
  const limited = await playlistRateLimit(c);
  if (limited) return limited;
  const session = await currentSession(c);
  try {
    const res = await getPlaylistDetail(playlistId, session?.credential || "", {
      offset,
      limit,
    });
    const safeDetail = sanitizePlaylistDetailForClient(res);
    if (!safeDetail) return upstreamFailure(c);
    return privateJson(c, safeDetail);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/song-url", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || Object.keys(body).some((key) => key !== "id" && key !== "br")) {
    return privateJson(c, { error: "Invalid audio request" }, 400);
  }
  const id = normalizeAudioId(body.id);
  const br = normalizeAudioBitrate(body.br);
  if (!id || br === null) {
    return privateJson(c, { error: "Invalid audio request" }, 400);
  }
  const session = await currentSession(c);
  if (!session) {
    return privateJson(c, { error: "Unauthorized" }, 401);
  }
  return privateJson(c, {
    data: {
      data: [{ url: neteaseAudioPath(id, br), br, size: 0 }],
    },
  });
});

neteaseRoutes.get("/audio", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const keys = [...params.keys()];
  if (
    keys.some((key) => key !== "id" && key !== "br") ||
    params.getAll("id").length !== 1 ||
    params.getAll("br").length !== 1
  ) {
    return privateJson(c, { error: "Invalid audio request" }, 400);
  }
  const id = normalizeAudioId(params.get("id"));
  const rawBr = params.get("br");
  const br = rawBr && /^\d{1,7}$/.test(rawBr) ? Number(rawBr) : null;
  if (
    !id ||
    br === null ||
    !NETEASE_AUDIO_BITRATES.has(br) ||
    !isValidAudioRange(c.req.header("Range"))
  ) {
    return privateJson(c, { error: "Invalid audio request" }, 400);
  }

  const session = await currentSession(c);
  if (!session) {
    return privateJson(c, { error: "Unauthorized" }, 401);
  }
  const limited = await audioRateLimit(c);
  if (limited) return limited;

  try {
    const resolved = await getSongUrl(id, br, session.credential);
    if (classifySensitiveData(resolved).hasCredential) {
      throw new Error("Unsafe audio response");
    }
    const upstreamUrl = resolved.data?.data?.[0]?.url;
    if (!upstreamUrl) throw new Error("Audio unavailable");
    return await proxyNeteaseAudio(upstreamUrl, c.req.header("Range"));
  } catch {
    return privateJson(c, { error: SAFE_AUDIO_UPSTREAM_ERROR }, 502);
  }
});

neteaseRoutes.post("/song-detail", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["id"]));
  const id = body?.id;
  if (typeof id !== "string" || !NETEASE_TRACK_ID.test(id)) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }

  const session = await currentSession(c);
  try {
    const res = await getSongDetail(id, session?.credential || "");
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/lyric", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["id"]));
  const id = body?.id;
  if (typeof id !== "string" || !NETEASE_TRACK_ID.test(id)) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }

  const session = await currentSession(c);
  try {
    const res = await getLyric(id, session?.credential || "");
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/playlist/dynamic", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["id"]));
  const id = body?.id;
  if (typeof id !== "string" || !NETEASE_PLAYLIST_ID.test(id)) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }

  const session = await currentSession(c);
  try {
    const res = await getPlaylistDynamicDetail(id, session?.credential || "");
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 获取每日推荐歌单
 * @method POST
 * @path /recommend
 * @returns {Promise<{ result: RecommendPlaylist[] }>}
 */
neteaseRoutes.post("/recommend", async (c) => {
  const session = await currentSession(c);
  if (!session) return privateJson(c, { error: "Unauthorized" }, 401);
  try {
    const res = await getRecommendPlaylists(session.credential);
    return privateJson(c, res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 获取排行榜
 * @method POST
 * @path /toplist
 * @returns {Promise<{ list: Toplist[] }>}
 */
neteaseRoutes.post("/toplist", async (c) => {
  const session = await currentSession(c);
  try {
    const res = await getToplist(session?.credential || "");
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 获取专辑详情
 * @method POST
 * @path /album
 * @body {string} id - Album ID
 * @returns {Promise<AlbumDetail>}
 */
neteaseRoutes.post("/album", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["id"]));
  const id = body?.id;
  if (typeof id !== "string" || !NETEASE_ALBUM_ID.test(id)) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }
  const session = await currentSession(c);
  try {
    const res = await getAlbum(id, session?.credential || "");
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/album/dynamic", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["id"]));
  const id = body?.id;
  if (typeof id !== "string" || !NETEASE_ALBUM_ID.test(id)) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }

  const session = await currentSession(c);
  try {
    const res = await getAlbumDynamicDetail(id, session?.credential || "");
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 获取艺人详情
 * @method POST
 * @path /artist
 * @body {string} id - Artist ID
 * @returns {Promise<ArtistDetail>}
 */
neteaseRoutes.post("/artist", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["id"]));
  const id = body?.id;
  if (typeof id !== "string" || !NETEASE_ARTIST_ID.test(id)) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }
  const session = await currentSession(c);
  try {
    const res = await getArtist(id, session?.credential || "");
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/artist/dynamic", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["id"]));
  const id = body?.id;
  if (typeof id !== "string" || !NETEASE_ARTIST_ID.test(id)) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }

  const session = await currentSession(c);
  try {
    const res = await getArtistDynamicDetail(id, session?.credential || "");
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/artist/songs", async (c) => {
  const body = await readStrictJsonObject(
    c,
    new Set(["id", "limit", "offset", "order"])
  );
  const id = body?.id;
  const limit = body?.limit ?? 50;
  const offset = body?.offset ?? 0;
  const order = body?.order ?? "hot";
  if (
    typeof id !== "string" ||
    !NETEASE_ARTIST_ID.test(id) ||
    !isIntegerInRange(limit, 1, 100) ||
    !isIntegerInRange(offset, 0, 10_000) ||
    (order !== "hot" && order !== "time")
  ) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }

  const session = await currentSession(c);
  try {
    const res = await getArtistSongs(
      id,
      limit,
      offset,
      order,
      session?.credential || ""
    );
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/artist/albums", async (c) => {
  const body = await readStrictJsonObject(
    c,
    new Set(["id", "limit", "offset"])
  );
  const id = body?.id;
  const limit = body?.limit ?? 30;
  const offset = body?.offset ?? 0;
  if (
    typeof id !== "string" ||
    !NETEASE_ARTIST_ID.test(id) ||
    !isIntegerInRange(limit, 1, 100) ||
    !isIntegerInRange(offset, 0, 10_000)
  ) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }

  const session = await currentSession(c);
  try {
    const res = await getArtistAlbums(
      id,
      limit,
      offset,
      session?.credential || ""
    );
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 获取分类歌单
 * @method POST
 * @path /playlists
 * @body {string} cat - Category
 * @body {string} order - Order (hot/new)
 * @body {number} limit - Limit
 * @body {number} offset - Offset
 * @returns {Promise<{ playlists: UserPlaylist[] }>}
 */
neteaseRoutes.post("/playlists", async (c) => {
  const body = await readStrictJsonObject(
    c,
    new Set(["cat", "order", "limit", "offset"])
  );
  const cat = body?.cat ?? "全部";
  const order = body?.order ?? "hot";
  const limit = body?.limit ?? 35;
  const offset = body?.offset ?? 0;
  if (
    typeof cat !== "string" ||
    !isSafeKeyword(cat, 64) ||
    (order !== "hot" && order !== "new") ||
    !isIntegerInRange(limit, 1, 50) ||
    !isIntegerInRange(offset, 0, 10_000)
  ) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }
  const session = await currentSession(c);
  try {
    const res = await getPlaylists(
      cat,
      order,
      limit,
      offset,
      session?.credential || ""
    );
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/album/sublist", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["limit", "offset"]));
  const limit = body?.limit ?? 25;
  const offset = body?.offset ?? 0;
  if (
    !body ||
    !isIntegerInRange(limit, 1, 100) ||
    !isIntegerInRange(offset, 0, 10_000)
  ) {
    return privateJson(c, { error: "Invalid pagination" }, 400);
  }
  const session = await currentSession(c);
  if (!session) return privateJson(c, { error: "Unauthorized" }, 401);
  try {
    const res = await getSubscribedAlbums(limit, offset, session.credential);
    return privateJson(c, res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/artist/sublist", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["limit", "offset"]));
  const limit = body?.limit ?? 25;
  const offset = body?.offset ?? 0;
  if (
    !body ||
    !isIntegerInRange(limit, 1, 100) ||
    !isIntegerInRange(offset, 0, 10_000)
  ) {
    return privateJson(c, { error: "Invalid pagination" }, 400);
  }
  const session = await currentSession(c);
  if (!session) return privateJson(c, { error: "Unauthorized" }, 401);
  try {
    const res = await getSubscribedArtists(limit, offset, session.credential);
    return privateJson(c, res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 解析 URL
 * @method POST
 * @path /resolve
 * @body {string} url - NetEase Cloud Music URL
 * @returns {Promise<ResolveUrlResult>}
 */
neteaseRoutes.post("/resolve", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["url"]));
  const url = body?.url;
  if (typeof url !== "string" || url.length < 1 || url.length > 2_048) {
    return privateJson(c, { error: "Invalid URL" }, 400);
  }
  try {
    const res = resolveUrl(url);
    if (!res) return c.json({ error: "Invalid URL" }, 400);
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 搜索歌曲/歌单
 * @method POST
 * @path /search
 * @body {string} keyword - Search keyword
 * @body {number} type - Search type (1: songs default, 1000: playlists)
 * @body {number} page - Page number (default: 1)
 * @body {number} limit - Page size (default: 20)
 * @returns {Promise<{ data: { result: SearchResult, code: number } }>}
 */
neteaseRoutes.post("/search", async (c) => {
  const body = await readStrictJsonObject(
    c,
    new Set(["keyword", "type", "page", "limit"])
  );
  const keyword = body?.keyword;
  const type = body?.type ?? 1;
  const page = body?.page ?? 1;
  const limit = body?.limit ?? 20;
  if (
    !isSafeKeyword(keyword) ||
    (type !== 1 && type !== 1000) ||
    !isIntegerInRange(page, 1, 100) ||
    !isIntegerInRange(limit, 1, 50)
  ) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }
  const name = keyword.trim();

  const session = await currentSession(c);
  try {
    const res = await search(
      name,
      type,
      page,
      limit,
      session?.credential || ""
    );
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/search/suggest", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["keyword"]));
  const keyword = body?.keyword;
  if (!isSafeKeyword(keyword)) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }
  const term = keyword.trim();

  const session = await currentSession(c);
  try {
    const res = await searchSuggest(term, session?.credential || "");
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/comments/hot", async (c) => {
  const body = await readStrictJsonObject(
    c,
    new Set(["id", "limit", "offset"])
  );
  const id = body?.id;
  const limit = body?.limit ?? 20;
  const offset = body?.offset ?? 0;
  if (
    typeof id !== "string" ||
    !NETEASE_TRACK_ID.test(id) ||
    !isIntegerInRange(limit, 1, 100) ||
    !isIntegerInRange(offset, 0, 10_000)
  ) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }

  const session = await currentSession(c);
  try {
    const res = await getHotComments(
      id,
      limit,
      offset,
      session?.credential || ""
    );
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/comments/new", async (c) => {
  const body = await readStrictJsonObject(
    c,
    new Set(["id", "pageNo", "pageSize", "sortType", "cursor"])
  );
  const id = body?.id;
  const pageNo = body?.pageNo ?? 1;
  const pageSize = body?.pageSize ?? 20;
  const sortType = body?.sortType ?? 2;
  const cursor = body?.cursor ?? 0;
  const validCursor =
    isIntegerInRange(cursor, 0, Number.MAX_SAFE_INTEGER) ||
    (typeof cursor === "string" && /^\d{1,24}$/.test(cursor));
  if (
    typeof id !== "string" ||
    !NETEASE_TRACK_ID.test(id) ||
    !isIntegerInRange(pageNo, 1, 500) ||
    !isIntegerInRange(pageSize, 1, 100) ||
    !isIntegerInRange(sortType, 1, 3) ||
    !validCursor
  ) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }

  const session = await currentSession(c);
  try {
    const res = await getNewComments(
      id,
      pageNo,
      pageSize,
      sortType,
      cursor,
      session?.credential || ""
    );
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

neteaseRoutes.post("/comments", async (c) => {
  const body = await readStrictJsonObject(
    c,
    new Set(["id", "limit", "offset"])
  );
  const id = body?.id;
  const limit = body?.limit ?? 20;
  const offset = body?.offset ?? 0;
  if (
    typeof id !== "string" ||
    !NETEASE_TRACK_ID.test(id) ||
    !isIntegerInRange(limit, 1, 100) ||
    !isIntegerInRange(offset, 0, 10_000)
  ) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }

  const session = await currentSession(c);
  try {
    const res = await getMusicComments(
      id,
      limit,
      offset,
      session?.credential || ""
    );
    return c.json(res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 收藏/取消收藏歌手
 * @method POST
 * @path /artist/sub
 * @body {string} id - Artist ID
 * @body {boolean} shouldSub - true to subscribe, false to unsubscribe
 * @returns {Promise<{ code: number, message?: string }>}
 */
neteaseRoutes.post("/artist/sub", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["id", "shouldSub"]));
  const id = body?.id;
  const shouldSub = body?.shouldSub;
  if (
    typeof id !== "string" ||
    !NETEASE_ARTIST_ID.test(id) ||
    typeof shouldSub !== "boolean"
  ) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }
  const session = await currentSession(c);
  if (!session) return privateJson(c, { error: "Unauthorized" }, 401);
  try {
    const res = await toggleSubArtist(id, shouldSub, session.credential);
    return privateJson(c, res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 收藏/取消收藏专辑
 * @method POST
 * @path /album/sub
 * @body {string} id - Album ID
 * @body {boolean} shouldSub - true to subscribe, false to unsubscribe
 * @returns {Promise<{ code: number, message?: string }>}
 */
neteaseRoutes.post("/album/sub", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["id", "shouldSub"]));
  const id = body?.id;
  const shouldSub = body?.shouldSub;
  if (
    typeof id !== "string" ||
    !NETEASE_ALBUM_ID.test(id) ||
    typeof shouldSub !== "boolean"
  ) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }
  const session = await currentSession(c);
  if (!session) return privateJson(c, { error: "Unauthorized" }, 401);
  try {
    const res = await toggleSubAlbum(id, shouldSub, session.credential);
    return privateJson(c, res);
  } catch {
    return upstreamFailure(c);
  }
});

/**
 * 收藏/取消收藏歌单
 * @method POST
 * @path /playlist/sub
 * @body {string} id - Playlist ID
 * @body {boolean} shouldSub - true to subscribe, false to unsubscribe
 * @returns {Promise<{ code: number, message?: string }>}
 */
neteaseRoutes.post("/playlist/sub", async (c) => {
  const body = await readStrictJsonObject(c, new Set(["id", "shouldSub"]));
  const id = body?.id;
  const shouldSub = body?.shouldSub;
  if (
    typeof id !== "string" ||
    !NETEASE_PLAYLIST_ID.test(id) ||
    typeof shouldSub !== "boolean"
  ) {
    return privateJson(c, { error: "Invalid request" }, 400);
  }
  const session = await currentSession(c);
  if (!session) return privateJson(c, { error: "Unauthorized" }, 401);
  try {
    const res = await toggleSubPlaylist(id, shouldSub, session.credential);
    return privateJson(c, res);
  } catch {
    return upstreamFailure(c);
  }
});
