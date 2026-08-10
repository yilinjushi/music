import { Hono, type Context } from "hono";
import type { Env } from "../../types/hono";
import {
  fetchBilibiliSearch,
  createBilibiliAudioRequestBudget,
  fetchBilibiliDashCandidates,
  fetchBilibiliDurlSongUrls,
  fetchBilibiliSearchCollections,
  fetchBilibiliCollectionDetail,
  proxyBilibiliAudio,
  proxyBilibiliCover,
} from "../../utils/music/bilibili-api";
import { z } from "zod";
import {
  checkFixedWindowRateLimit,
  requestClientId,
} from "../../utils/request-rate-limit";
import {
  FUNCTION_LOG_EVENTS,
  logFunctionError,
} from "../../utils/security-logger";
import { isAllowedRequestOrigin } from "../../middleware/cors";
import { isValidAudioRange } from "../../utils/proxy/audio";

export const bilibiliRoutes = new Hono<{ Bindings: Env }>();

const bvidSchema = z.string().regex(/^BV[0-9A-Za-z]{10}$/);
const mediaUrlSchema = z.string().url().max(4096);
const PRIVATE_NO_STORE = "private, no-store, max-age=0";

function markPrivateCapability(c: Context<{ Bindings: Env }>) {
  c.header("Cache-Control", PRIVATE_NO_STORE);
  c.header("Pragma", "no-cache");
}

function privateCapabilityResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", PRIVATE_NO_STORE);
  headers.set("Pragma", "no-cache");
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function isCrossSiteMediaRequest(c: Context<{ Bindings: Env }>): boolean {
  if (c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site") {
    return true;
  }
  const origin = c.req.header("Origin");
  return origin
    ? !isAllowedRequestOrigin(c.req.url, origin, c.env.APP_ORIGIN)
    : false;
}

function audioPath(bvid: string, cid?: number): string {
  const query = new URLSearchParams({ bvid });
  if (cid !== undefined) query.set("cid", String(cid));
  return `/music-api/bilibili/audio?${query.toString()}`;
}

async function enforceMediaRateLimit(
  c: Context<{ Bindings: Env }>
): Promise<Response | null> {
  const rate = await checkFixedWindowRateLimit(
    c.env.oh_file_url,
    "bilibili-media",
    requestClientId(c.req.raw.headers),
    120,
    60
  );
  c.header("X-RateLimit-Remaining", String(rate.remaining));
  if (rate.allowed) return null;
  c.header("Retry-After", String(rate.retryAfterSeconds));
  return c.json({ error: "too many media requests" }, 429);
}

bilibiliRoutes.post("/search", async (c) => {
  const { keyword, page, rows } = await c.req.json<{
    keyword: string;
    page: number;
    rows?: number;
  }>();
  if (!keyword || keyword.length > 100)
    return c.json({ error: "invalid keyword" }, 400);

  try {
    return c.json(await fetchBilibiliSearch(keyword, page ?? 1, rows ?? 20));
  } catch (e: any) {
    logFunctionError(FUNCTION_LOG_EVENTS.BILIBILI_SEARCH_FAILED);
    return c.json({ error: e.message || "Internal error" }, 500);
  }
});

bilibiliRoutes.post("/song-url", async (c) => {
  markPrivateCapability(c);
  const { bvid, cid } = await c.req.json<{ bvid: string; cid?: number }>();
  if (!bvidSchema.safeParse(bvid).success)
    return c.json({ error: "invalid bvid" }, 400);
  if (cid !== undefined && (!Number.isSafeInteger(cid) || cid <= 0))
    return c.json({ error: "invalid cid" }, 400);

  // Compatibility endpoint: return only a same-origin opaque reference. The
  // short-lived upstream URL is resolved by /audio and never enters browser JS.
  return c.json({ url: audioPath(bvid, cid) });
});

bilibiliRoutes.get("/audio", async (c) => {
  markPrivateCapability(c);
  if (isCrossSiteMediaRequest(c)) {
    return c.json({ error: "cross-site media request rejected" }, 403);
  }
  const range = c.req.header("Range");
  if (!isValidAudioRange(range)) {
    return c.json({ error: "invalid range" }, 400);
  }
  const query = c.req.query();
  if (Object.keys(query).some((key) => key !== "bvid" && key !== "cid")) {
    return c.json({ error: "invalid audio query" }, 400);
  }
  const bvid = c.req.query("bvid");
  const rawCid = c.req.query("cid");
  const cid = rawCid === undefined ? undefined : Number(rawCid);
  if (
    !bvidSchema.safeParse(bvid).success ||
    (cid !== undefined && (!Number.isSafeInteger(cid) || cid <= 0))
  ) {
    return c.json({ error: "invalid bvid or cid" }, 400);
  }
  const limited = await enforceMediaRateLimit(c);
  if (limited) return limited;

  try {
    const budget = createBilibiliAudioRequestBudget({
      signal: c.req.raw.signal,
    });
    const dash = await fetchBilibiliDashCandidates(bvid, cid, budget);
    if (!dash) {
      return c.json({ error: "audio unavailable" }, 502);
    }
    for (const mediaUrl of dash.urls) {
      try {
        const response = await proxyBilibiliAudio(
          bvid,
          mediaUrl,
          range,
          budget
        );
        if (response.ok || response.status === 206) {
          return privateCapabilityResponse(response);
        }
        await response.body?.cancel().catch(() => undefined);
      } catch {
        // Try the next provider-supplied CDN candidate within the fixed cap.
      }
    }

    // Resolve the legacy endpoint only after every DASH CDN fails. The shared
    // selector exposes only a single-file, browser-native durl result, and the
    // same absolute deadline/request budget bounds this extra fallback.
    const durlUrls = await fetchBilibiliDurlSongUrls(bvid, dash.cid, budget);
    for (const mediaUrl of durlUrls) {
      try {
        const response = await proxyBilibiliAudio(
          bvid,
          mediaUrl,
          range,
          budget
        );
        if (response.ok || response.status === 206) {
          return privateCapabilityResponse(response);
        }
        await response.body?.cancel().catch(() => undefined);
      } catch {
        // Continue only while the shared media-attempt budget permits it.
      }
    }
    return c.json({ error: "audio unavailable" }, 502);
  } catch {
    logFunctionError(FUNCTION_LOG_EVENTS.BILIBILI_AUDIO_PROXY_FAILED);
    return c.json({ error: "Bilibili audio upstream failed" }, 502);
  }
});

bilibiliRoutes.get("/cover", async (c) => {
  if (isCrossSiteMediaRequest(c)) {
    c.header("Cache-Control", PRIVATE_NO_STORE);
    return c.json({ error: "cross-site media request rejected" }, 403);
  }
  const limited = await enforceMediaRateLimit(c);
  if (limited) return limited;
  const url = c.req.query("url");
  if (!mediaUrlSchema.safeParse(url).success)
    return c.json({ error: "invalid url" }, 400);

  try {
    return proxyBilibiliCover(url);
  } catch (e: any) {
    logFunctionError(FUNCTION_LOG_EVENTS.BILIBILI_COVER_PROXY_FAILED);
    return c.json({ error: e.message || "Internal error" }, 500);
  }
});

bilibiliRoutes.post("/search-collections", async (c) => {
  const { keyword, page, rows } = await c.req.json<{
    keyword: string;
    page?: number;
    rows?: number;
  }>();
  if (!keyword || keyword.length > 100)
    return c.json({ error: "invalid keyword" }, 400);

  try {
    return c.json(
      await fetchBilibiliSearchCollections(keyword, page ?? 1, rows ?? 20)
    );
  } catch (e: any) {
    logFunctionError(FUNCTION_LOG_EVENTS.BILIBILI_COLLECTION_SEARCH_FAILED);
    return c.json({ error: e.message || "Internal error" }, 500);
  }
});

bilibiliRoutes.post("/collection-detail", async (c) => {
  const { albumId, page, pageSize } = await c.req.json<{
    albumId: string;
    page?: number;
    pageSize?: number;
  }>();
  if (!albumId) return c.json({ error: "albumId required" }, 400);

  try {
    const result = await fetchBilibiliCollectionDetail(
      albumId,
      page ?? 1,
      pageSize ?? 30
    );
    return c.json(result);
  } catch (e: any) {
    logFunctionError(FUNCTION_LOG_EVENTS.BILIBILI_COLLECTION_DETAIL_FAILED);
    return c.json({ error: e.message || "Internal error" }, 500);
  }
});
