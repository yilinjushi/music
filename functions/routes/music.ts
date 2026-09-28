import { Hono, type Context } from "hono";
import type { Env } from "../types/hono";
import { handleNeteaseRequest } from "@utils/music/netease-handler";
import { neteaseRoutes } from "./music/netease";
import { qqmusicRoutes } from "./music/qqmusic";
import { kugouRoutes } from "./music/kugou";
import { kuwoRoutes } from "./music/kuwo";
import { miguRoutes } from "./music/migu";
import { bilibiliRoutes } from "./music/bilibili";
import {
  classifySensitiveData,
  containsSensitiveData,
  containsSensitiveSearchParams,
  containsSensitiveString,
  getFromCache,
  isAccountRequest,
  isCapabilityRequest,
  isSensitiveFieldName,
  putToCache,
} from "@utils/cache";
import { FUNCTION_LOG_EVENTS, logFunctionError } from "@utils/security-logger";
import { fetchUpstreamWithDeadline } from "@otter-music/shared";
import { isValidAudioRange, proxyPrivateAudio } from "@utils/proxy/audio";
import {
  NETEASE_SESSION_COOKIE,
  readNeteaseSession,
} from "@utils/netease-session";
import {
  checkFixedWindowRateLimit,
  requestClientId,
} from "@utils/request-rate-limit";
import { createQiniuAudioCache } from "@utils/qiniu-audio-cache";

export const musicRoutes = new Hono<{ Bindings: Env }>();

const API_BASE = "https://music-api.gdstudio.xyz/api.php";
const PRIVATE_NO_STORE = "private, no-store, max-age=0";
const GENERIC_AUDIO_SOURCES = new Set(["netease", "joox", "kuwo"]);
const GENERIC_AUDIO_BITRATES = new Set([128, 192, 320, 999]);
const GENERIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const AUDIO_CACHE_SOURCES = new Set([
  "netease",
  "_netease",
  "joox",
  "kuwo",
  "qq",
  "migu",
  "bilibili",
]);
const AUDIO_CACHE_ID_PATTERN = /^[A-Za-z0-9._~:+/=-]{1,256}$/;
const AUDIO_CACHE_PLAYLIST_ID_PATTERN =
  /^(?:(?:neplaylist|ne_playlist)_)?\d{1,20}$/;
export type MusicContext = Context<{ Bindings: Env }>;

export function resolveAudioCache(c: MusicContext) {
  return (
    c.env.AUDIO_CACHE ??
    createQiniuAudioCache(c.env, (promise) => c.executionCtx.waitUntil(promise))
  );
}

function isAudioCacheIdentifier(value: unknown): value is string {
  return typeof value === "string" && AUDIO_CACHE_ID_PATTERN.test(value);
}

function rejectSensitiveRequest(c: MusicContext) {
  c.header("Cache-Control", PRIVATE_NO_STORE);
  c.header("Pragma", "no-cache");
  return c.json({ error: "Sensitive credential data is not accepted" }, 400);
}

function markPrivateAudio(c: MusicContext): void {
  c.header("Cache-Control", PRIVATE_NO_STORE);
  c.header("Pragma", "no-cache");
}

function genericAudioPath(source: string, id: string, br: number): string {
  return `/music-api/audio?${new URLSearchParams({
    source,
    id,
    br: String(br),
  }).toString()}`;
}

function isGenericAudioId(source: string, id: string): boolean {
  if (source === "netease") return /^\d{1,20}$/.test(id);
  if (source === "kuwo") return /^(?:MUSIC_)?\d{1,20}$/.test(id);
  if (source === "joox") {
    if (
      id.length < 2 ||
      id.length > 256 ||
      !/^[A-Za-z0-9+/_-]+={0,2}$/.test(id)
    ) {
      return false;
    }
    return id.includes("=") ? id.length % 4 === 0 : id.length % 4 !== 1;
  }
  return false;
}

function parseGenericAudioDescriptor(
  params: URLSearchParams,
  allowType: boolean
): { source: string; id: string; br: number } | null {
  const allowedKeys = allowType
    ? new Set(["types", "type", "source", "id", "br"])
    : new Set(["source", "id", "br"]);
  if ([...params.keys()].some((key) => !allowedKeys.has(key))) return null;
  if (
    params.getAll("source").length !== 1 ||
    params.getAll("id").length !== 1 ||
    (allowType
      ? params.getAll("br").length > 1
      : params.getAll("br").length !== 1)
  ) {
    return null;
  }
  if (allowType) {
    const types = params.getAll("types");
    const type = params.getAll("type");
    if (
      types.length + type.length !== 1 ||
      (types[0] ?? type[0])?.toLowerCase() !== "url"
    ) {
      return null;
    }
  }
  const source = params.get("source") || "";
  const id = params.get("id") || "";
  const rawBr = params.get("br") ?? "192";
  const br = /^\d{3}$/.test(rawBr) ? Number(rawBr) : NaN;
  return GENERIC_AUDIO_SOURCES.has(source) &&
    isGenericAudioId(source, id) &&
    GENERIC_AUDIO_BITRATES.has(br)
    ? { source, id, br }
    : null;
}

function genericProviderHeaders(source: string): Record<string, string> {
  const referers: Record<string, string> = {
    netease: "https://music.163.com/",
    joox: "https://www.joox.com/",
    kuwo: "https://www.kuwo.cn/",
  };
  return { Referer: referers[source], "User-Agent": GENERIC_USER_AGENT };
}

async function resolveGenericAudioUrl(
  source: string,
  id: string,
  br: number
): Promise<string | null> {
  const query = new URLSearchParams({
    types: "url",
    source,
    id,
    br: String(br),
  });
  return fetchUpstreamWithDeadline(
    `${API_BASE}?${query.toString()}`,
    { headers: { "User-Agent": GENERIC_USER_AGENT } },
    async (response) => {
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        classifySensitiveData(payload).hasCredential
      ) {
        return null;
      }
      const url = (payload as { url?: unknown }).url;
      return typeof url === "string" && url.length <= 4096 ? url : null;
    },
    { responseType: "json" }
  );
}

async function enforceGenericAudioRateLimit(
  c: MusicContext
): Promise<Response | null> {
  try {
    const rate = await checkFixedWindowRateLimit(
      c.env.oh_file_url,
      "generic-audio",
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

function cookieContainsSensitiveData(
  value: string,
  allowNeteaseSessionCookie: boolean
): boolean {
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator < 1) return true;
    const name = trimmed.slice(0, separator).trim();
    const cookieValue = trimmed.slice(separator + 1).trim();
    if (allowNeteaseSessionCookie && name === NETEASE_SESSION_COOKIE) {
      if (!/^[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{43}$/.test(cookieValue)) {
        return true;
      }
      continue;
    }
    if (containsSensitiveString(trimmed)) return true;
  }
  return false;
}

function requestHeadersContainSensitiveData(
  headers: Headers,
  allowNeteaseSessionCookie: boolean
): boolean {
  let found = false;
  headers.forEach((value, name) => {
    if (name.toLowerCase() === "cookie") {
      if (cookieContainsSensitiveData(value, allowNeteaseSessionCookie)) {
        found = true;
      }
      return;
    }
    if (isSensitiveFieldName(name) || containsSensitiveString(value)) {
      found = true;
    }
  });
  return found;
}

interface RequestBodyInspection {
  containsSensitiveData: boolean;
  parsedBody?: unknown;
}

function isCellphoneLoginPayload(pathname: string, value: unknown): boolean {
  if (pathname !== "/netease/login/cellphone") return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.phone === "string" &&
    /^1\d{10}$/.test(body.phone) &&
    typeof body.password === "string" &&
    body.password.length >= 1 &&
    body.password.length <= 256
  );
}

async function readBoundedRequestText(
  request: Request
): Promise<string | null> {
  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_REQUEST_BODY_BYTES)
  ) {
    return null;
  }

  const body = request.clone().body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function inspectRequestBody(
  request: Request
): Promise<RequestBodyInspection> {
  if (["GET", "HEAD"].includes(request.method.toUpperCase())) {
    return { containsSensitiveData: false };
  }
  const contentType = request.headers.get("Content-Type")?.toLowerCase() || "";

  if (contentType.includes("multipart/form-data")) {
    // Music routes do not accept file uploads. Rejecting multipart here also
    // avoids asking the runtime to buffer an attacker-controlled form body.
    return { containsSensitiveData: true };
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      const text = await readBoundedRequestText(request);
      if (text === null) return { containsSensitiveData: true };
      return {
        containsSensitiveData: containsSensitiveSearchParams(
          new URLSearchParams(text)
        ),
      };
    } catch {
      return { containsSensitiveData: false };
    }
  }

  if (contentType.includes("application/json")) {
    try {
      const text = await readBoundedRequestText(request);
      if (text === null) return { containsSensitiveData: true };
      const parsedBody: unknown = JSON.parse(text);
      return {
        containsSensitiveData: containsSensitiveData(parsedBody),
        parsedBody,
      };
    } catch {
      // A mislabeled body is still scanned as text before downstream parsing.
    }
  }

  try {
    const text = await readBoundedRequestText(request);
    if (text === null) return { containsSensitiveData: true };
    return {
      containsSensitiveData: containsSensitiveString(text),
    };
  } catch {
    return { containsSensitiveData: false };
  }
}

musicRoutes.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (containsSensitiveSearchParams(url.searchParams)) {
    return rejectSensitiveRequest(c);
  }

  if (
    requestHeadersContainSensitiveData(
      c.req.raw.headers,
      url.pathname.startsWith("/netease/") || url.pathname.startsWith("/cache/")
    )
  ) {
    return rejectSensitiveRequest(c);
  }

  const bodyInspection = await inspectRequestBody(c.req.raw);
  if (
    bodyInspection.containsSensitiveData &&
    !isCellphoneLoginPayload(url.pathname, bodyInspection.parsedBody)
  ) {
    return rejectSensitiveRequest(c);
  }

  const capabilityRequest = isCapabilityRequest(
    c.req.raw,
    bodyInspection.parsedBody
  );

  await next();

  if (isAccountRequest(c.req.raw)) {
    c.res.headers.set("Cache-Control", PRIVATE_NO_STORE);
    c.res.headers.set("Pragma", "no-cache");
  }

  if (capabilityRequest) {
    c.res.headers.set("Cache-Control", PRIVATE_NO_STORE);
    c.res.headers.set("Pragma", "no-cache");
  }

  if (!c.res.headers.get("Content-Type")?.includes("application/json")) return;

  // Never forward exception details from any provider route.
  if (c.res.status >= 500) {
    c.res = c.json({ error: "Music upstream failed" }, 502);
    c.res.headers.set("Cache-Control", PRIVATE_NO_STORE);
    c.res.headers.set("Pragma", "no-cache");
    return;
  }

  const payload = await c.res
    .clone()
    .json()
    .catch(() => null);
  if (payload !== null) {
    const classification = classifySensitiveData(payload);
    const unsafe =
      classification.hasCredential ||
      (classification.hasCapability && !capabilityRequest);
    if (!unsafe) return;
    c.res = c.json({ error: "Unsafe upstream response rejected" }, 502);
    c.res.headers.set("Cache-Control", PRIVATE_NO_STORE);
    c.res.headers.set("Pragma", "no-cache");
  }
});

musicRoutes.post("/cache/lookup", async (c) => {
  const cache = resolveAudioCache(c);
  if (!cache) return c.json({ error: "Audio cache unavailable" }, 404);
  const body = await c.req.json<unknown>().catch(() => null);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !["source", "id", "urlId"].includes(key))
  ) {
    return c.json({ error: "Invalid audio cache request" }, 400);
  }
  const record = body as Record<string, unknown>;
  if (
    typeof record.source !== "string" ||
    !AUDIO_CACHE_SOURCES.has(record.source) ||
    !isAudioCacheIdentifier(record.id) ||
    (record.urlId !== undefined && !isAudioCacheIdentifier(record.urlId))
  ) {
    return c.json({ error: "Invalid audio cache request" }, 400);
  }
  try {
    const cached = await cache.lookup({
      source: record.source,
      id: record.id,
      urlId: record.urlId as string | undefined,
    });
    if (!cached) return c.json({ error: "Audio cache miss" }, 404);
    return c.json(cached);
  } catch {
    return c.json({ error: "Audio cache unavailable" }, 503);
  }
});

musicRoutes.get("/cache/audio", async (c) => {
  const cache = resolveAudioCache(c);
  if (!cache) return c.json({ error: "Audio cache unavailable" }, 404);
  const cacheKey = new URL(c.req.url).searchParams.get("key") || "";
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
    return c.json({ error: "Invalid audio cache key" }, 400);
  }
  try {
    const response = await cache.serve(cacheKey, c.req.header("Range"));
    return response ?? c.json({ error: "Audio cache miss" }, 404);
  } catch {
    return c.json({ error: "Audio cache unavailable" }, 503);
  }
});

musicRoutes.post("/cache/netease-playlist", async (c) => {
  const cache = resolveAudioCache(c);
  if (!cache) return c.json({ error: "Audio cache unavailable" }, 404);
  const body = await c.req.json<unknown>().catch(() => null);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as Record<string, unknown>).playlistId !== "string" ||
    !AUDIO_CACHE_PLAYLIST_ID_PATTERN.test(
      (body as Record<string, unknown>).playlistId as string
    )
  ) {
    return c.json({ error: "Invalid playlist ID" }, 400);
  }

  try {
    const session = await readNeteaseSession(c.env, c.req.header("Cookie"));
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    return c.json(
      await cache.startNeteasePlaylistJob(
        (body as Record<string, unknown>).playlistId as string,
        session.credential
      )
    );
  } catch {
    return c.json({ error: "Audio cache unavailable" }, 503);
  }
});

musicRoutes.post("/cache/netease-track", async (c) => {
  const cache = resolveAudioCache(c);
  if (!cache) return c.json({ error: "Audio cache unavailable" }, 404);
  const body = await c.req.json<unknown>().catch(() => null);
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (
    !record ||
    Object.keys(record).some(
      (key) => !["id", "urlId", "name", "artist", "duration"].includes(key)
    ) ||
    !isAudioCacheIdentifier(record.id) ||
    (record.urlId !== undefined && !isAudioCacheIdentifier(record.urlId)) ||
    typeof record.name !== "string" ||
    !Array.isArray(record.artist) ||
    !record.artist.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 256
    ) ||
    (record.duration !== undefined &&
      (typeof record.duration !== "number" ||
        !Number.isFinite(record.duration)))
  ) {
    return c.json({ error: "Invalid audio cache request" }, 400);
  }

  try {
    const session = await readNeteaseSession(c.env, c.req.header("Cookie"));
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const rate = await checkFixedWindowRateLimit(
      c.env.oh_file_url,
      "audio-cache-track",
      requestClientId(c.req.raw.headers),
      60,
      600
    );
    if (!rate.allowed) {
      c.header("Retry-After", String(rate.retryAfterSeconds));
      return c.json({ error: "Too many audio cache requests" }, 429);
    }
    const state = await cache.cacheNeteaseTrack(
      {
        id: record.id as string,
        urlId: record.urlId as string | undefined,
        name: record.name,
        artist: record.artist as string[],
        duration: record.duration as number | undefined,
      },
      session.credential
    );
    return c.json({ state }, state === "queued" ? 202 : 200);
  } catch (error) {
    if (error instanceof TypeError) {
      return c.json({ error: "Invalid audio cache request" }, 400);
    }
    return c.json({ error: "Audio cache unavailable" }, 503);
  }
});

export const AUDIO_CACHE_CRON_TARGET_KEY = "audio-cache-cron-target:v1";

// Called by the app when the 红心 playlist opens: runs one bounded sync step in
// the background and remembers this session + playlist as the cron target.
musicRoutes.post("/cache/netease-playlist-sync", async (c) => {
  const cache = resolveAudioCache(c);
  if (!cache) return c.json({ error: "Audio cache unavailable" }, 404);
  const body = await c.req.json<unknown>().catch(() => null);
  const playlistId =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).playlistId
      : undefined;
  if (
    typeof playlistId !== "string" ||
    !AUDIO_CACHE_PLAYLIST_ID_PATTERN.test(playlistId) ||
    Object.keys(body as object).length !== 1
  ) {
    return c.json({ error: "Invalid playlist ID" }, 400);
  }
  try {
    const session = await readNeteaseSession(c.env, c.req.header("Cookie"));
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const rate = await checkFixedWindowRateLimit(
      c.env.oh_file_url,
      "audio-cache-sync",
      requestClientId(c.req.raw.headers),
      2,
      60
    );
    if (!rate.allowed) return c.json({ state: "throttled" }, 202);
    await c.env.oh_file_url.put(
      AUDIO_CACHE_CRON_TARGET_KEY,
      JSON.stringify({ sessionId: session.id, playlistId })
    );
    c.executionCtx.waitUntil(
      cache
        .syncNeteasePlaylist(playlistId, session.credential)
        .catch(() => undefined)
    );
    return c.json({ state: "started" }, 202);
  } catch {
    return c.json({ error: "Audio cache unavailable" }, 503);
  }
});

musicRoutes.get("/cache/playlist-status", async (c) => {
  const cache = resolveAudioCache(c);
  if (!cache) return c.json({ error: "Audio cache unavailable" }, 404);
  const playlistId = new URL(c.req.url).searchParams.get("playlistId") || "";
  if (!AUDIO_CACHE_PLAYLIST_ID_PATTERN.test(playlistId)) {
    return c.json({ error: "Invalid playlist ID" }, 400);
  }
  try {
    const session = await readNeteaseSession(c.env, c.req.header("Cookie"));
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const status = await cache.getPlaylistStatus(playlistId);
    return status ? c.json(status) : c.json({ error: "No status yet" }, 404);
  } catch {
    return c.json({ error: "Audio cache unavailable" }, 503);
  }
});

/** Song ids the owner's phone should keep offline for this playlist. */
musicRoutes.get("/cache/playlist-offline", async (c) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  const cache = resolveAudioCache(c);
  if (!cache?.getReadyTrackIds) {
    return c.json({ error: "Audio cache unavailable" }, 404);
  }
  const playlistId = new URL(c.req.url).searchParams.get("playlistId") || "";
  if (!AUDIO_CACHE_PLAYLIST_ID_PATTERN.test(playlistId)) {
    return c.json({ error: "Invalid playlist ID" }, 400);
  }
  try {
    const session = await readNeteaseSession(c.env, c.req.header("Cookie"));
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const ids = await cache.getReadyTrackIds(playlistId);
    return ids ? c.json({ ids }) : c.json({ error: "No status yet" }, 404);
  } catch {
    return c.json({ error: "Audio cache unavailable" }, 503);
  }
});

musicRoutes.get("/cache/jobs/:jobId", async (c) => {
  const cache = resolveAudioCache(c);
  if (!cache) return c.json({ error: "Audio cache unavailable" }, 404);
  const job = await cache.getJob(c.req.param("jobId"));
  return job
    ? c.json(job)
    : c.json({ error: "Audio cache job not found" }, 404);
});

musicRoutes.get("/audio", async (c) => {
  markPrivateAudio(c);
  if (c.req.header("Sec-Fetch-Site") === "cross-site") {
    return c.json({ error: "Cross-site request rejected" }, 403);
  }
  const descriptor = parseGenericAudioDescriptor(
    new URL(c.req.url).searchParams,
    false
  );
  if (!descriptor || !isValidAudioRange(c.req.header("Range"))) {
    return c.json({ error: "Invalid audio request" }, 400);
  }
  const limited = await enforceGenericAudioRateLimit(c);
  if (limited) return limited;

  try {
    const upstreamUrl = await resolveGenericAudioUrl(
      descriptor.source,
      descriptor.id,
      descriptor.br
    );
    if (!upstreamUrl) throw new Error("Audio unavailable");
    return await proxyPrivateAudio(
      upstreamUrl,
      genericProviderHeaders(descriptor.source),
      c.req.header("Range")
    );
  } catch {
    logFunctionError(FUNCTION_LOG_EVENTS.MUSIC_UPSTREAM_FAILED);
    return c.json({ error: "Music audio upstream failed" }, 502);
  }
});

/**
 * 音乐主路由，支持网易云适配器拦截和上游代理
 */
musicRoutes.get("/", async (c) => {
  const requestUrl = new URL(c.req.url);
  const requestedType = (
    requestUrl.searchParams.get("types") ??
    requestUrl.searchParams.get("type") ??
    ""
  ).toLowerCase();
  if (requestedType === "url") {
    markPrivateAudio(c);
    if (requestUrl.searchParams.get("source") === "_netease") {
      return handleNeteaseRequest(c, c.req.query());
    }
    const descriptor = parseGenericAudioDescriptor(
      requestUrl.searchParams,
      true
    );
    if (!descriptor) {
      return c.json({ error: "Invalid audio request" }, 400);
    }
    return c.json({
      url: genericAudioPath(descriptor.source, descriptor.id, descriptor.br),
    });
  }
  const query = c.req.query();
  const capabilityRequest = isCapabilityRequest(c.req.raw);

  // 1. Backend Adapter: Intercept NetEase requests (Not cached here as it has its own logic)
  if (query.source === "_netease") {
    return handleNeteaseRequest(c, query);
  }

  // 2. Try Cache
  const cachedResponse = capabilityRequest
    ? null
    : await getFromCache(c.req.raw);
  if (cachedResponse) {
    // Return a new response from the cached one to ensure headers are fresh
    return new Response(cachedResponse.body, cachedResponse);
  }

  // 3. Fallback to Upstream Proxy
  const searchParams = new URLSearchParams(query);
  const targetUrl = `${API_BASE}?${searchParams.toString()}`;

  try {
    const upstream = await fetchUpstreamWithDeadline(
      targetUrl,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      },
      async (response) => {
        if (!response.ok) return { ok: false as const };
        return { ok: true as const, data: await response.json() };
      },
      { responseType: "json" }
    );

    if (!upstream.ok) {
      return c.json({ error: "Music upstream failed" }, 502);
    }

    const data = upstream.data;
    const classification = classifySensitiveData(data);
    if (
      classification.hasCredential ||
      (classification.hasCapability && !capabilityRequest)
    ) {
      return c.json({ error: "Unsafe upstream response rejected" }, 502, {
        "Cache-Control": PRIVATE_NO_STORE,
        Pragma: "no-cache",
      });
    }
    const response = c.json(data);

    // 4. Save to Cache (Async)
    if (!capabilityRequest) {
      c.executionCtx.waitUntil(putToCache(c.req.raw, response.clone(), "api"));
    }

    return response;
  } catch {
    logFunctionError(FUNCTION_LOG_EVENTS.MUSIC_UPSTREAM_FAILED);
    return c.json({ error: "Music upstream failed" }, 502, {
      "Cache-Control": PRIVATE_NO_STORE,
      Pragma: "no-cache",
    });
  }
});

musicRoutes.route("/netease", neteaseRoutes);
musicRoutes.route("/qqmusic", qqmusicRoutes);
musicRoutes.route("/kugou", kugouRoutes);
musicRoutes.route("/kuwo", kuwoRoutes);
musicRoutes.route("/migu", miguRoutes);
musicRoutes.route("/bilibili", bilibiliRoutes);
