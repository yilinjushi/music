import { Hono, type Context } from "hono";
import type { Env } from "../../types/hono";
import {
  fetchMiguPlaylistDetail,
  fetchMiguSearch,
  fetchMiguSongUrl,
  proxyMiguAudio,
  isMiguPlaylistShortLink,
  resolveMiguShortPlaylistId,
} from "../../utils/music/migu-api";
import { isValidAudioRange } from "../../utils/proxy/audio";
import {
  checkFixedWindowRateLimit,
  requestClientId,
} from "../../utils/request-rate-limit";
import {
  FUNCTION_LOG_EVENTS,
  logFunctionError,
} from "../../utils/security-logger";
import { isAllowedRequestOrigin } from "../../middleware/cors";
import { containsControlCharacter } from "@otter-music/shared";

export const miguRoutes = new Hono<{ Bindings: Env }>();
type MiguContext = Context<{ Bindings: Env }>;

const PRIVATE_NO_STORE = "private, no-store, max-age=0";
const MIGU_MEDIA_ID = /^[A-Za-z0-9.-]{1,128}$/;
const MIGU_PLAYLIST_ID = /^\d{1,20}$/;
const MIGU_BITRATES = new Set([128, 192, 320, 999]);
const ALLOWED_FETCH_SITES = new Set(["same-origin", "same-site"]);

function rejectsPublicRequestSource(c: MiguContext): boolean {
  const fetchSite = c.req.header("Sec-Fetch-Site")?.toLowerCase();
  const origin = c.req.header("Origin");
  if (!fetchSite || !ALLOWED_FETCH_SITES.has(fetchSite) || !origin) return true;
  return !isAllowedRequestOrigin(c.req.url, origin, c.env.APP_ORIGIN);
}

async function enforcePublicRateLimit(
  c: MiguContext,
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
    return c.json({ error: "Too many public music requests" }, 429);
  } catch {
    return c.json({ error: "Public music rate limiter unavailable" }, 503);
  }
}

async function readStrictJsonObject(
  c: MiguContext,
  allowedKeys: ReadonlySet<string>
): Promise<Record<string, unknown> | null> {
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return Object.keys(record).every((key) => allowedKeys.has(key))
    ? record
    : null;
}

function markPrivateAudio(c: MiguContext): void {
  c.header("Cache-Control", PRIVATE_NO_STORE);
  c.header("Pragma", "no-cache");
}

function miguAudioPath(
  copyrightId: string,
  contentId: string,
  br: number
): string {
  return `/music-api/migu/audio?${new URLSearchParams({
    copyrightId,
    contentId,
    br: String(br),
  }).toString()}`;
}

async function enforceAudioRateLimit(c: MiguContext): Promise<Response | null> {
  try {
    const rate = await checkFixedWindowRateLimit(
      c.env.oh_file_url,
      "migu-audio",
      requestClientId(c.req.raw.headers),
      120,
      60
    );
    c.header("X-RateLimit-Remaining", String(rate.remaining));
    if (rate.allowed) return null;
    c.header("Retry-After", String(rate.retryAfterSeconds));
    return c.json({ error: "Too many audio requests" }, 429);
  } catch {
    return c.json({ error: "Audio rate limiter unavailable" }, 503);
  }
}

/**
 * 解析咪咕歌单分享短链。
 */
miguRoutes.post("/resolve-playlist", async (c) => {
  if (rejectsPublicRequestSource(c)) {
    return c.json({ error: "Cross-site request rejected" }, 403);
  }
  const body = await readStrictJsonObject(c, new Set(["url"]));
  const url = body?.url;
  if (typeof url !== "string" || !isMiguPlaylistShortLink(url)) {
    return c.json({ error: "invalid Migu playlist short URL" }, 400);
  }
  const limited = await enforcePublicRateLimit(c, "migu-playlist", 12);
  if (limited) return limited;

  try {
    const playlistId = await resolveMiguShortPlaylistId(url);
    if (!playlistId)
      return c.json({ error: "unable to resolve playlist ID" }, 400);
    return c.json({ playlistId });
  } catch {
    logFunctionError(FUNCTION_LOG_EVENTS.MIGU_SHORT_URL_FAILED);
    return c.json({ error: "Migu short URL upstream failed" }, 502);
  }
});

/**
 * 获取咪咕公开歌单详情。
 */
miguRoutes.post("/playlist", async (c) => {
  if (rejectsPublicRequestSource(c)) {
    return c.json({ error: "Cross-site request rejected" }, 403);
  }
  const body = await readStrictJsonObject(c, new Set(["playlistId"]));
  const playlistId = body?.playlistId;
  if (typeof playlistId !== "string" || !MIGU_PLAYLIST_ID.test(playlistId)) {
    return c.json({ error: "invalid playlistId" }, 400);
  }
  const limited = await enforcePublicRateLimit(c, "migu-playlist", 12);
  if (limited) return limited;

  try {
    return c.json(await fetchMiguPlaylistDetail(playlistId));
  } catch {
    logFunctionError(FUNCTION_LOG_EVENTS.MIGU_API_FAILED);
    return c.json({ error: "Migu playlist upstream failed" }, 502);
  }
});

/**
 * 获取咪咕歌曲播放地址。
 */
miguRoutes.post("/song-url", async (c) => {
  markPrivateAudio(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (
    !body ||
    Object.keys(body).some(
      (key) => key !== "copyrightId" && key !== "contentId" && key !== "br"
    )
  ) {
    return c.json({ error: "invalid audio request" }, 400);
  }
  const copyrightId = body.copyrightId;
  const contentId = body.contentId;
  const br = body.br === undefined ? 192 : body.br;
  if (
    typeof copyrightId !== "string" ||
    !MIGU_MEDIA_ID.test(copyrightId) ||
    typeof contentId !== "string" ||
    !MIGU_MEDIA_ID.test(contentId) ||
    typeof br !== "number" ||
    !MIGU_BITRATES.has(br)
  ) {
    return c.json({ error: "invalid audio request" }, 400);
  }
  return c.json({ url: miguAudioPath(copyrightId, contentId, br) });
});

miguRoutes.get("/audio", async (c) => {
  markPrivateAudio(c);
  if (c.req.header("Sec-Fetch-Site") === "cross-site") {
    return c.json({ error: "Cross-site request rejected" }, 403);
  }
  const params = new URL(c.req.url).searchParams;
  if (
    [...params.keys()].some(
      (key) => key !== "copyrightId" && key !== "contentId" && key !== "br"
    ) ||
    params.getAll("copyrightId").length !== 1 ||
    params.getAll("contentId").length !== 1 ||
    params.getAll("br").length !== 1
  ) {
    return c.json({ error: "invalid audio request" }, 400);
  }
  const copyrightId = params.get("copyrightId") || "";
  const contentId = params.get("contentId") || "";
  const rawBr = params.get("br") || "";
  const br = /^\d{3}$/.test(rawBr) ? Number(rawBr) : NaN;
  if (
    !MIGU_MEDIA_ID.test(copyrightId) ||
    !MIGU_MEDIA_ID.test(contentId) ||
    !MIGU_BITRATES.has(br) ||
    !isValidAudioRange(c.req.header("Range"))
  ) {
    return c.json({ error: "invalid audio request" }, 400);
  }

  const limited = await enforceAudioRateLimit(c);
  if (limited) return limited;
  try {
    const upstreamUrl = await fetchMiguSongUrl(copyrightId, contentId, br);
    if (!upstreamUrl) throw new Error("Audio unavailable");
    return await proxyMiguAudio(upstreamUrl, c.req.header("Range"));
  } catch {
    logFunctionError(FUNCTION_LOG_EVENTS.MIGU_SONG_URL_FAILED);
    return c.json({ error: "Migu audio upstream failed" }, 502);
  }
});

/**
 * 咪咕歌曲搜索。
 */
miguRoutes.post("/search", async (c) => {
  if (rejectsPublicRequestSource(c)) {
    return c.json({ error: "Cross-site request rejected" }, 403);
  }
  const body = await readStrictJsonObject(
    c,
    new Set(["keyword", "page", "rows"])
  );
  const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";
  const page = body?.page ?? 1;
  const rows = body?.rows ?? 20;
  if (
    !keyword ||
    keyword.length > 100 ||
    containsControlCharacter(keyword) ||
    !Number.isSafeInteger(page) ||
    Number(page) < 1 ||
    Number(page) > 100 ||
    !Number.isSafeInteger(rows) ||
    Number(rows) < 1 ||
    Number(rows) > 50
  ) {
    return c.json({ error: "invalid search request" }, 400);
  }
  const limited = await enforcePublicRateLimit(c, "migu-search", 60);
  if (limited) return limited;

  try {
    return c.json(await fetchMiguSearch(keyword, Number(page), Number(rows)));
  } catch {
    logFunctionError(FUNCTION_LOG_EVENTS.MIGU_SEARCH_FAILED);
    return c.json({ error: "Migu search upstream failed" }, 502);
  }
});
