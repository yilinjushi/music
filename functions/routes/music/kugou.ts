import { Hono, type Context } from "hono";
import type { Env } from "../../types/hono";
import {
  fetchKugouPlaylistDetail,
  resolveKugouShortUrl,
} from "../../utils/music/kugou-api";
import {
  FUNCTION_LOG_EVENTS,
  logFunctionError,
} from "../../utils/security-logger";
import {
  checkFixedWindowRateLimit,
  requestClientId,
} from "../../utils/request-rate-limit";
import { isAllowedRequestOrigin } from "../../middleware/cors";

export const kugouRoutes = new Hono<{ Bindings: Env }>();
type KugouContext = Context<{ Bindings: Env }>;

const KUGOU_PLAYLIST_ID = /^(?:\d{1,20}|gcid_[a-z0-9]{1,64})$/i;
const ALLOWED_FETCH_SITES = new Set(["same-origin", "same-site"]);

function rejectsPublicRequestSource(c: KugouContext): boolean {
  const fetchSite = c.req.header("Sec-Fetch-Site")?.toLowerCase();
  const origin = c.req.header("Origin");
  if (!fetchSite || !ALLOWED_FETCH_SITES.has(fetchSite) || !origin) return true;
  return !isAllowedRequestOrigin(c.req.url, origin, c.env.APP_ORIGIN);
}

async function enforcePlaylistRateLimit(
  c: KugouContext
): Promise<Response | null> {
  try {
    const rate = await checkFixedWindowRateLimit(
      c.env.oh_file_url,
      "kugou-playlist",
      requestClientId(c.req.raw.headers),
      12,
      60
    );
    c.header("X-RateLimit-Remaining", String(rate.remaining));
    if (rate.allowed) return null;
    c.header("Retry-After", String(rate.retryAfterSeconds));
    return c.json({ error: "Too many playlist requests" }, 429);
  } catch {
    return c.json({ error: "Playlist rate limiter unavailable" }, 503);
  }
}

async function readStrictJsonObject(
  c: KugouContext,
  key: string
): Promise<Record<string, unknown> | null> {
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return Object.keys(record).every((name) => name === key) ? record : null;
}

function isApprovedKugouShortUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^t\d+\.kugou\.com$/i.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

/**
 * 解析酷狗分享短链。
 */
kugouRoutes.post("/resolve-shortlink", async (c) => {
  if (rejectsPublicRequestSource(c)) {
    return c.json({ error: "Cross-site request rejected" }, 403);
  }
  const body = await readStrictJsonObject(c, "url");
  const url = body?.url;
  if (
    typeof url !== "string" ||
    url.length > 2_048 ||
    !isApprovedKugouShortUrl(url)
  ) {
    return c.json({ error: "invalid Kugou short URL" }, 400);
  }
  const limited = await enforcePlaylistRateLimit(c);
  if (limited) return limited;

  try {
    const resolvedUrl = await resolveKugouShortUrl(url);
    if (!resolvedUrl)
      return c.json({ error: "unable to resolve short link" }, 400);
    return c.json({ resolvedUrl });
  } catch {
    logFunctionError(FUNCTION_LOG_EVENTS.KUGOU_SHORT_URL_FAILED);
    return c.json({ error: "Kugou short URL upstream failed" }, 502);
  }
});

/**
 * 获取酷狗公开歌单详情。
 */
kugouRoutes.post("/playlist", async (c) => {
  if (rejectsPublicRequestSource(c)) {
    return c.json({ error: "Cross-site request rejected" }, 403);
  }
  const body = await readStrictJsonObject(c, "playlistId");
  const playlistId = body?.playlistId;
  if (typeof playlistId !== "string" || !KUGOU_PLAYLIST_ID.test(playlistId)) {
    return c.json({ error: "invalid playlistId" }, 400);
  }
  const limited = await enforcePlaylistRateLimit(c);
  if (limited) return limited;

  try {
    return c.json(await fetchKugouPlaylistDetail(playlistId));
  } catch {
    logFunctionError(FUNCTION_LOG_EVENTS.KUGOU_API_FAILED);
    return c.json({ error: "Kugou playlist upstream failed" }, 502);
  }
});
