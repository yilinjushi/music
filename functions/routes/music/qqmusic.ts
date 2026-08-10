import { Hono, type Context } from "hono";
import { QQ_FILE_CONFIG } from "@otter-music/shared";
import type { Env } from "../../types/hono";
import {
  fetchQqPlaylistDetail,
  fetchQqMusicSearch,
  fetchQqMusicLyric,
  fetchQqMusicUrl,
  proxyQqMusicAudio,
} from "../../utils/music/qqmusic-api";
import { isValidAudioRange } from "../../utils/proxy/audio";
import {
  checkFixedWindowRateLimit,
  requestClientId,
} from "../../utils/request-rate-limit";
import {
  FUNCTION_LOG_EVENTS,
  logFunctionError,
} from "../../utils/security-logger";
import { classifySensitiveData } from "../../utils/cache";

export const qqmusicRoutes = new Hono<{ Bindings: Env }>();
type QqContext = Context<{ Bindings: Env }>;

const QQ_SONGMID = /^[A-Za-z0-9_-]{1,64}$/;
type QqQuality = (typeof QQ_FILE_CONFIG)[number]["key"];
const QQ_QUALITIES = new Set<string>(QQ_FILE_CONFIG.map((item) => item.key));
const PRIVATE_NO_STORE = "private, no-store, max-age=0";

function markPrivateCapability(c: {
  header(name: string, value: string, options?: { append?: boolean }): void;
}) {
  c.header("Cache-Control", PRIVATE_NO_STORE);
  c.header("Pragma", "no-cache");
}

function qqAudioPath(songmid: string, quality: string): string {
  return `/music-api/qqmusic/audio?${new URLSearchParams({
    songmid,
    quality,
  }).toString()}`;
}

function isQqQuality(value: string): value is QqQuality {
  return QQ_QUALITIES.has(value);
}

async function enforceAudioRateLimit(c: QqContext): Promise<Response | null> {
  try {
    const rate = await checkFixedWindowRateLimit(
      c.env.oh_file_url,
      "qqmusic-audio",
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
 * 获取 QQ 音乐歌单详情
 */
qqmusicRoutes.post("/playlist", async (c) => {
  const { playlistId } = await c.req.json<{ playlistId: string }>();
  if (!playlistId) return c.json({ error: "playlistId required" }, 400);

  try {
    const detail = await fetchQqPlaylistDetail(playlistId);
    return c.json(detail);
  } catch (e: any) {
    logFunctionError(FUNCTION_LOG_EVENTS.QQMUSIC_API_FAILED);
    return c.json({ error: e.message || "Internal error" }, 500);
  }
});

/**
 * QQ 音乐通用代理端点
 * @method POST
 * @path /proxy
 * @body { type: 'search' | 'lyric', query?, page?, songmid? }
 */
qqmusicRoutes.post("/proxy", async (c) => {
  const body = await c.req
    .json<{
      type: "search" | "lyric" | "url";
      query?: string;
      page?: number;
      songmid?: string;
      quality?: string;
    }>()
    .catch(() => null);

  if (!body) return c.json({ error: "invalid request" }, 400);

  try {
    if (body.type === "search") {
      if (!body.query) return c.json({ error: "query required" }, 400);
      const result = await fetchQqMusicSearch(body.query, body.page ?? 1);
      return c.json(result);
    }
    if (body.type === "lyric") {
      if (!body.songmid) return c.json({ error: "songmid required" }, 400);
      const result = await fetchQqMusicLyric(body.songmid);
      if (!result) return c.json({ error: "lyric not found" }, 404);
      return c.json(result);
    }
    if (body.type === "url") {
      markPrivateCapability(c);
      if (
        Object.keys(body).some(
          (key) => key !== "type" && key !== "songmid" && key !== "quality"
        ) ||
        !body.songmid ||
        !QQ_SONGMID.test(body.songmid)
      ) {
        return c.json({ error: "invalid audio request" }, 400);
      }
      const quality = body.quality || "320k";
      if (!isQqQuality(quality)) {
        return c.json({ error: "invalid audio request" }, 400);
      }
      return c.json({ url: qqAudioPath(body.songmid, quality) });
    }
    return c.json({ error: "invalid type" }, 400);
  } catch (e: any) {
    logFunctionError(FUNCTION_LOG_EVENTS.QQMUSIC_PROXY_FAILED);
    return c.json({ error: e.message || "Internal error" }, 500);
  }
});

qqmusicRoutes.get("/audio", async (c) => {
  markPrivateCapability(c);
  if (c.req.header("Sec-Fetch-Site") === "cross-site") {
    return c.json({ error: "Cross-site request rejected" }, 403);
  }
  const params = new URL(c.req.url).searchParams;
  if (
    [...params.keys()].some((key) => key !== "songmid" && key !== "quality") ||
    params.getAll("songmid").length !== 1 ||
    params.getAll("quality").length !== 1
  ) {
    return c.json({ error: "invalid audio request" }, 400);
  }
  const songmid = params.get("songmid") || "";
  const quality = params.get("quality") || "";
  if (
    !QQ_SONGMID.test(songmid) ||
    !isQqQuality(quality) ||
    !isValidAudioRange(c.req.header("Range"))
  ) {
    return c.json({ error: "invalid audio request" }, 400);
  }

  const limited = await enforceAudioRateLimit(c);
  if (limited) return limited;

  try {
    const resolved = await fetchQqMusicUrl(songmid, quality);
    if (classifySensitiveData(resolved).hasCredential || !resolved.url) {
      throw new Error("Audio unavailable");
    }
    return await proxyQqMusicAudio(resolved.url, c.req.header("Range"));
  } catch {
    return c.json({ error: "QQ Music audio upstream failed" }, 502);
  }
});
