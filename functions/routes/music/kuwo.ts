import { Hono, type Context } from "hono";
import type { Env } from "../../types/hono";
import { fetchKuwoPlaylistDetail } from "../../utils/music/kuwo-api";
import {
  FUNCTION_LOG_EVENTS,
  logFunctionError,
} from "../../utils/security-logger";
import {
  checkFixedWindowRateLimit,
  requestClientId,
} from "../../utils/request-rate-limit";
import { isAllowedRequestOrigin } from "../../middleware/cors";

export const kuwoRoutes = new Hono<{ Bindings: Env }>();
type KuwoContext = Context<{ Bindings: Env }>;

const KUWO_PLAYLIST_ID = /^\d{1,20}$/;
const ALLOWED_FETCH_SITES = new Set(["same-origin", "same-site"]);

function rejectsPublicRequestSource(c: KuwoContext): boolean {
  const fetchSite = c.req.header("Sec-Fetch-Site")?.toLowerCase();
  const origin = c.req.header("Origin");
  if (!fetchSite || !ALLOWED_FETCH_SITES.has(fetchSite) || !origin) return true;
  return !isAllowedRequestOrigin(c.req.url, origin, c.env.APP_ORIGIN);
}

async function enforcePlaylistRateLimit(
  c: KuwoContext
): Promise<Response | null> {
  try {
    const rate = await checkFixedWindowRateLimit(
      c.env.oh_file_url,
      "kuwo-playlist",
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

async function readPlaylistId(c: KuwoContext): Promise<string | null> {
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "playlistId")) return null;
  return typeof record.playlistId === "string" &&
    KUWO_PLAYLIST_ID.test(record.playlistId)
    ? record.playlistId
    : null;
}

/** 获取酷我公开歌单详情。 */
kuwoRoutes.post("/playlist", async (c) => {
  if (rejectsPublicRequestSource(c)) {
    return c.json({ error: "Cross-site request rejected" }, 403);
  }
  const playlistId = await readPlaylistId(c);
  if (!playlistId) return c.json({ error: "invalid playlistId" }, 400);

  const limited = await enforcePlaylistRateLimit(c);
  if (limited) return limited;

  try {
    return c.json(await fetchKuwoPlaylistDetail(playlistId));
  } catch {
    logFunctionError(FUNCTION_LOG_EVENTS.KUWO_API_FAILED);
    return c.json({ error: "Kuwo playlist upstream failed" }, 502);
  }
});
