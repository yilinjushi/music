import {
  fetchUpstreamWithDeadline,
  type SongDetail,
} from "@otter-music/shared";
import type {
  AudioCacheJobStatus,
  AudioCacheLike,
  AudioCacheLookupResult,
  AudioCacheNeteaseTrack,
  AudioCacheSyncResult,
  AudioCacheTrackReference,
  AudioCacheTrackState,
  Env,
} from "../types/hono";
import {
  getPlaylistDetailPreferAnonymous,
  getSongUrl,
  NETEASE_PLAYLIST_MAX_TOTAL_TRACKS,
  NETEASE_PLAYLIST_PAGE_SIZE,
} from "./music/netease-api";
import { normalizeProxyTarget } from "./proxy/fetch";

const CACHE_KEY_PREFIX = "audio-cache:v1:";
const JOB_KEY_PREFIX = "audio-cache-job:v1:";
const ACTIVE_PLAYLIST_KEY_PREFIX = "audio-cache-playlist:v1:";
const ACTIVE_TRACK_KEY_PREFIX = "audio-cache-track:v1:";
const ACTIVE_TRACK_TTL_SECONDS = 10 * 60;
const PENDING_KEY_PREFIX = "audio-cache-pending:v1:";
const MISS_KEY_PREFIX = "audio-cache-miss:v1:";
const PLAYLIST_STATUS_KEY_PREFIX = "audio-cache-playlist-status:v1:";
const PLAYLIST_TRACKS_KEY_PREFIX = "audio-cache-playlist-tracks:v1:";
const PLAYLIST_TRACKS_FULL_REFRESH_MS = 6 * 60 * 60_000;
// A track with no complete source is retried on later runs; after this many
// failed rounds it is reported as unavailable (and re-checked after the TTL).
const MISS_ROUNDS_BEFORE_UNAVAILABLE = 3;
const MISS_TTL_SECONDS = 30 * 24 * 60 * 60;
const PENDING_VERIFY_AFTER_MS = 20_000;
const PENDING_GIVE_UP_AFTER_MS = 15 * 60_000;
const SYNC_DEFAULT_TIME_BUDGET_MS = 20_000;
const SYNC_DEFAULT_SUBREQUEST_BUDGET = 40;
const OBJECT_KEY_PREFIX = "otter-music-cache/v1";
const JOB_TTL_SECONDS = 24 * 60 * 60;
const CACHE_QUALITIES = [320, 192, 128] as const;
const CACHE_JOB_CONCURRENCY = 3;
const QINIU_FETCH_POLL_ATTEMPTS = 15;
const QINIU_FETCH_POLL_DELAY_MS = 1_000;
const GENERIC_MUSIC_API_URL = "https://music-api.gdstudio.xyz/api.php";
const GENERIC_SOURCES = ["joox", "kuwo"] as const;
const AUDIO_CACHE_ID_PATTERN = /^[A-Za-z0-9._~:+/=-]{1,256}$/;
const NETEASE_PLAYLIST_ID_PATTERN =
  /^(?:(?:neplaylist|ne_playlist)_)?\d{1,20}$/;
const AUDIO_MIME_ESSENCE =
  /^(?:audio\/[a-z0-9!#$&^_.+-]+|video\/mp4|application\/octet-stream)$/;

interface QiniuAudioCacheConfig {
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  domain: string;
  objectPrefix: string;
}

interface QiniuCacheRecord {
  version: 1;
  state: "ready";
  targetKey: string;
  objectKey: string;
  storedBr: number;
  contentType: string;
  byteSize?: number;
  createdAt: number;
}

interface QiniuAudioCacheJob extends AudioCacheJobStatus {
  playlistId: string;
}

interface QiniuFetchTask {
  id?: unknown;
  wait?: unknown;
}

interface QiniuPlaylistTrack {
  id: string;
  urlId: string;
  name: string;
  artist: string[];
  duration?: number;
}

type GenericSource = "netease" | (typeof GENERIC_SOURCES)[number];

interface QiniuCacheCandidate {
  source: "_netease" | "netease" | GenericSource;
  id: string;
  urlId: string;
  name: string;
  artist: string[];
  duration?: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

function normalizeId(value: string): string {
  return value.replace(/^(?:neplaylist_|ne_playlist_|netrack_|ne_track_)/, "");
}

function canonicalTargetKey(track: AudioCacheTrackReference): string {
  const id = normalizeId(track.id);
  if (
    (track.source === "_netease" || track.source === "netease") &&
    /^\d{1,20}$/.test(id)
  ) {
    return `netease:${id}`;
  }
  return `${track.source}:${id}:${track.urlId ?? ""}`;
}

async function hashTargetKey(targetKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(targetKey)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function normalizeConfig(env: Env): QiniuAudioCacheConfig | null {
  const accessKey = env.QINIU_ACCESS_KEY?.trim();
  const secretKey = env.QINIU_SECRET_KEY?.trim();
  const bucket = env.QINIU_AUDIO_CACHE_BUCKET?.trim();
  const region = env.QINIU_AUDIO_CACHE_REGION?.trim();
  const domain = env.QINIU_AUDIO_CACHE_DOMAIN?.trim().replace(/\/$/, "");
  const objectPrefix =
    env.QINIU_AUDIO_CACHE_PREFIX?.trim().replace(/^\/+|\/+$/g, "") ||
    OBJECT_KEY_PREFIX;

  if (
    !accessKey ||
    !secretKey ||
    accessKey.length > 256 ||
    secretKey.length > 256 ||
    !bucket ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    !region ||
    !/^[a-z0-9-]{2,32}$/.test(region) ||
    !domain ||
    !/^https?:\/\/[^\s\\/]+$/i.test(domain) ||
    !objectPrefix ||
    objectPrefix.length > 128 ||
    !/^[A-Za-z0-9._/-]+$/.test(objectPrefix)
  ) {
    return null;
  }
  return { accessKey, secretKey, bucket, region, domain, objectPrefix };
}

async function hmacSha1(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );
  return new Uint8Array(signature);
}

function qiniuSigningString(
  method: string,
  url: URL,
  headers: Headers,
  body: string | undefined
): string {
  let value = `${method.toUpperCase()} ${url.pathname}${url.search}\nHost: ${url.host}`;
  const contentType = headers.get("Content-Type");
  if (contentType) value += `\nContent-Type: ${contentType}`;
  const qiniuHeaders: Array<[string, string]> = [];
  headers.forEach((headerValue, name) => {
    if (name.toLowerCase().startsWith("x-qiniu-")) {
      qiniuHeaders.push([name, headerValue]);
    }
  });
  qiniuHeaders.sort(([left], [right]) => left.localeCompare(right));
  for (const [name, headerValue] of qiniuHeaders) {
    const canonicalName = name
      .toLowerCase()
      .replace(
        /(^|-)([a-z])/g,
        (_match, prefix: string, character: string) =>
          `${prefix}${character.toUpperCase()}`
      );
    value += `\n${canonicalName}: ${headerValue}`;
  }
  value += "\n\n";
  if (body && contentType && contentType !== "application/octet-stream") {
    value += body;
  }
  return value;
}

async function qiniuRequest<T>(
  config: QiniuAudioCacheConfig,
  method: "GET" | "POST",
  path: string,
  body?: string
): Promise<T> {
  const url = new URL(`https://api-${config.region}.qiniuapi.com${path}`);
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  headers.set(
    "X-Qiniu-Date",
    new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z")
  );
  const signing = qiniuSigningString(method, url, headers, body);
  const signature = bytesToBase64Url(await hmacSha1(config.secretKey, signing));
  headers.set("Authorization", `Qiniu ${config.accessKey}:${signature}`);

  const response = await fetch(url, {
    method,
    headers,
    body,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("QINIU_REQUEST_FAILED");
  }
  const payload = (await response.json().catch(() => null)) as T | null;
  if (!payload) throw new Error("QINIU_INVALID_RESPONSE");
  return payload;
}

async function privateDownloadUrl(
  config: QiniuAudioCacheConfig,
  objectKey: string,
  expiresInSeconds = 300
): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const baseUrl = `${config.domain}/${objectKey
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
  const unsigned = `${baseUrl}?e=${expires}`;
  const signature = bytesToBase64Url(
    await hmacSha1(config.secretKey, unsigned)
  );
  return `${unsigned}&token=${encodeURIComponent(
    `${config.accessKey}:${signature}`
  )}`;
}

function cacheKeyForHash(hash: string): string {
  return `${CACHE_KEY_PREFIX}${hash}`;
}

function jobKey(jobId: string): string {
  return `${JOB_KEY_PREFIX}${jobId}`;
}

function activePlaylistKey(playlistId: string): string {
  return `${ACTIVE_PLAYLIST_KEY_PREFIX}${playlistId}`;
}

function activeTrackKey(hash: string): string {
  return `${ACTIVE_TRACK_KEY_PREFIX}${hash}`;
}

function objectKey(config: QiniuAudioCacheConfig, hash: string): string {
  return `${config.objectPrefix}/${hash}.audio`;
}

function publicJob(job: QiniuAudioCacheJob): AudioCacheJobStatus {
  return {
    jobId: job.jobId,
    state: job.state,
    total: job.total,
    processed: job.processed,
    cached: job.cached,
    skipped: job.skipped,
    failed: job.failed,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.error ? { error: job.error } : {}),
  };
}

function isSafePlaylistId(value: string): boolean {
  return NETEASE_PLAYLIST_ID_PATTERN.test(value);
}

function isSafeCacheTrack(track: QiniuPlaylistTrack): boolean {
  return (
    AUDIO_CACHE_ID_PATTERN.test(track.id) &&
    AUDIO_CACHE_ID_PATTERN.test(track.urlId) &&
    track.name.length > 0 &&
    track.name.length <= 512 &&
    track.artist.length > 0 &&
    track.artist.length <= 16
  );
}

function normalizeMatchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function isTrackMatch(
  target: QiniuPlaylistTrack,
  candidate: QiniuCacheCandidate
): boolean {
  if (normalizeMatchText(target.name) !== normalizeMatchText(candidate.name)) {
    return false;
  }

  const targetArtists = target.artist.map(normalizeMatchText).filter(Boolean);
  const candidateArtists = candidate.artist
    .map(normalizeMatchText)
    .filter(Boolean);
  if (!targetArtists.length || !candidateArtists.length) return false;

  const artistMatch = targetArtists.some((targetArtist) =>
    candidateArtists.some(
      (candidateArtist) =>
        targetArtist === candidateArtist ||
        targetArtist.includes(candidateArtist) ||
        candidateArtist.includes(targetArtist)
    )
  );
  if (!artistMatch) return false;

  if (
    Number.isFinite(target.duration) &&
    Number.isFinite(candidate.duration) &&
    Math.abs((target.duration ?? 0) - (candidate.duration ?? 0)) > 8
  ) {
    return false;
  }
  return true;
}

function providerHeaders(source: GenericSource): Record<string, string> {
  return {
    Referer:
      source === "joox"
        ? "https://www.joox.com/"
        : source === "kuwo"
          ? "https://www.kuwo.cn/"
          : "https://music.163.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
}

function normalizeCacheSourceUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:") parsed.protocol = "https:";
    return normalizeProxyTarget(parsed.toString())?.toString() ?? null;
  } catch {
    return null;
  }
}

async function genericSearch(
  source: GenericSource,
  target: QiniuPlaylistTrack
): Promise<QiniuCacheCandidate[]> {
  const query = `${target.name} ${target.artist[0] ?? ""}`.trim().slice(0, 240);
  if (!query) return [];
  const url = `${GENERIC_MUSIC_API_URL}?${new URLSearchParams({
    types: "search",
    source,
    name: query,
    count: "20",
    pages: "1",
  }).toString()}`;

  try {
    const raw = await fetchUpstreamWithDeadline(
      url,
      { headers: providerHeaders(source) },
      async (response) => {
        if (!response.ok) return [];
        const payload = await response.json();
        return Array.isArray(payload) ? payload : [];
      },
      { responseType: "json", deadlineMs: 10_000 }
    );

    return raw.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const rawId = record.url_id ?? record.id;
      const id =
        typeof rawId === "number" && Number.isSafeInteger(rawId)
          ? String(rawId)
          : typeof rawId === "string"
            ? rawId.trim()
            : "";
      const name = typeof record.name === "string" ? record.name : "";
      const rawArtist = record.artist;
      const artist = Array.isArray(rawArtist)
        ? rawArtist.filter(
            (value): value is string => typeof value === "string" && !!value
          )
        : typeof rawArtist === "string"
          ? [rawArtist]
          : [];
      if (!id || !AUDIO_CACHE_ID_PATTERN.test(id) || !name || !artist.length) {
        return [];
      }
      const duration =
        typeof record.duration === "number" &&
        Number.isFinite(record.duration) &&
        record.duration > 0
          ? record.duration
          : undefined;
      const candidate: QiniuCacheCandidate = {
        source,
        id,
        urlId: id,
        name,
        artist,
        duration,
      };
      return isTrackMatch(target, candidate) ? [candidate] : [];
    });
  } catch {
    return [];
  }
}

async function genericUrl(
  source: GenericSource,
  id: string,
  br: number
): Promise<string | null> {
  if (!AUDIO_CACHE_ID_PATTERN.test(id)) return null;
  const url = `${GENERIC_MUSIC_API_URL}?${new URLSearchParams({
    types: "url",
    source,
    id,
    br: String(br),
  }).toString()}`;
  try {
    const resolved = await fetchUpstreamWithDeadline(
      url,
      { headers: providerHeaders(source) },
      async (response) => {
        if (!response.ok) return null;
        const payload = (await response.json()) as { url?: unknown };
        const candidate = payload?.url;
        return typeof candidate === "string" && candidate.length <= 4096
          ? candidate
          : null;
      },
      { responseType: "json", deadlineMs: 10_000 }
    );
    return resolved ? normalizeCacheSourceUrl(resolved) : null;
  } catch {
    return null;
  }
}

function toCacheTrack(song: SongDetail): QiniuPlaylistTrack | null {
  if (!song || typeof song.id !== "number" || !Number.isSafeInteger(song.id)) {
    return null;
  }
  const artist = Array.isArray(song.ar)
    ? song.ar
        .map((item) => item?.name)
        .filter(
          (value): value is string => typeof value === "string" && !!value
        )
    : [];
  const name = typeof song.name === "string" ? song.name : "";
  const track: QiniuPlaylistTrack = {
    id: String(song.id),
    urlId: String(song.id),
    name,
    artist,
    ...(typeof song.dt === "number" && Number.isFinite(song.dt) && song.dt > 0
      ? { duration: song.dt / 1000 }
      : {}),
  };
  return isSafeCacheTrack(track) ? track : null;
}

function normalizeContentType(value: string | null): string {
  const essence = value?.split(";", 1)[0]?.trim().toLowerCase() || "";
  return AUDIO_MIME_ESSENCE.test(essence) ? essence : "audio/mpeg";
}

function responseByteSize(response: Response): number | undefined {
  const contentRange = response.headers.get("Content-Range");
  const rangeMatch = /^bytes \d{1,20}-\d{1,20}\/(\d{1,20})$/.exec(
    contentRange ?? ""
  );
  if (rangeMatch) {
    const total = BigInt(rangeMatch[1]);
    if (total > 0n && total <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(total);
    }
  }
  const contentLength = response.headers.get("Content-Length");
  if (!contentLength || !/^\d{1,20}$/.test(contentLength)) return undefined;
  const size = BigInt(contentLength);
  return size > 0n && size <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(size)
    : undefined;
}

function isValidRange(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (value.length > 64) return false;
  const match = /^bytes=(\d{1,20})-(\d{0,20})$|^bytes=-(\d{1,20})$/.exec(value);
  if (!match) return false;
  if (match[3] !== undefined) return BigInt(match[3]) > 0n;
  return match[2] === "" || BigInt(match[1]) <= BigInt(match[2]);
}

async function waitForObject(
  config: QiniuAudioCacheConfig,
  objectKeyValue: string
): Promise<{ contentType: string; byteSize?: number } | null> {
  const url = await privateDownloadUrl(config, objectKeyValue, 120);
  for (let attempt = 0; attempt < QINIU_FETCH_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, {
      headers: { Range: "bytes=0-0" },
    }).catch(() => null);
    if (response) {
      if (response.status === 200 || response.status === 206) {
        const byteSize = responseByteSize(response);
        await response.body?.cancel().catch(() => undefined);
        return {
          contentType: normalizeContentType(
            response.headers.get("Content-Type")
          ),
          ...(byteSize === undefined ? {} : { byteSize }),
        };
      }
      await response.body?.cancel().catch(() => undefined);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, QINIU_FETCH_POLL_DELAY_MS)
    );
  }
  return null;
}

/** One cheap existence check (a single subrequest), no polling. */
async function probeObject(
  config: QiniuAudioCacheConfig,
  objectKeyValue: string
): Promise<{ contentType: string; byteSize?: number } | null> {
  const url = await privateDownloadUrl(config, objectKeyValue, 120);
  const response = await fetch(url, { headers: { Range: "bytes=0-0" } }).catch(
    () => null
  );
  if (!response) return null;
  const ok = response.status === 200 || response.status === 206;
  const byteSize = ok ? responseByteSize(response) : undefined;
  const contentType = normalizeContentType(
    response.headers.get("Content-Type")
  );
  await response.body?.cancel().catch(() => undefined);
  if (!ok) return null;
  return { contentType, ...(byteSize === undefined ? {} : { byteSize }) };
}

/** Submit an asynchronous Qiniu fetch without waiting for it to finish. */
async function submitQiniuFetch(
  config: QiniuAudioCacheConfig,
  sourceUrl: string,
  objectKeyValue: string
): Promise<boolean> {
  const result = await qiniuRequest<QiniuFetchTask>(
    config,
    "POST",
    "/sisyphus/fetch",
    JSON.stringify({
      url: sourceUrl,
      bucket: config.bucket,
      key: objectKeyValue,
      ignore_same_key: true,
      file_type: 0,
    })
  ).catch(() => null);
  return typeof result?.id === "string" && result.id.length > 0;
}

/**
 * Best complete NetEase source at or below `maxBr` kbps. NetEase returns the
 * highest quality it can grant for the request, so one call covers the
 * 320 -> 192 -> 128 ladder; the actual bitrate is reported back.
 */
async function resolveNeteaseSource(
  track: QiniuPlaylistTrack,
  maxBr: number,
  credential: string
): Promise<{ url: string; br: number } | null> {
  try {
    const result = await getSongUrl(track.id, maxBr * 1000, credential);
    const entry = result?.data?.data?.[0] as
      { url?: unknown; br?: unknown; freeTrialInfo?: unknown } | undefined;
    const url = entry?.url;
    if (!url || typeof url !== "string" || url.length > 4096) return null;
    if (entry?.freeTrialInfo) return null;
    const normalized = normalizeCacheSourceUrl(url);
    if (!normalized) return null;
    const actual =
      typeof entry?.br === "number" && entry.br > 0
        ? Math.round(entry.br / 1000)
        : maxBr;
    return { url: normalized, br: Math.min(actual, maxBr) };
  } catch {
    return null;
  }
}

async function resolveNeteaseUrl(
  track: QiniuPlaylistTrack,
  br: number,
  credential: string
): Promise<string | null> {
  try {
    const result = await getSongUrl(track.id, br * 1000, credential);
    const entry = result?.data?.data?.[0] as
      { url?: unknown; freeTrialInfo?: unknown } | undefined;
    const url = entry?.url;
    if (!url || typeof url !== "string" || url.length > 4096) return null;
    // A non-null freeTrialInfo means NetEase only granted a ~30s preview.
    if (entry?.freeTrialInfo) return null;
    return normalizeCacheSourceUrl(url);
  } catch {
    return null;
  }
}

async function startQiniuFetch(
  config: QiniuAudioCacheConfig,
  sourceUrl: string,
  objectKeyValue: string
): Promise<void> {
  const result = await qiniuRequest<QiniuFetchTask>(
    config,
    "POST",
    "/sisyphus/fetch",
    JSON.stringify({
      url: sourceUrl,
      bucket: config.bucket,
      key: objectKeyValue,
      ignore_same_key: true,
      file_type: 0,
    })
  );
  if (
    typeof result.id !== "string" ||
    result.id.length < 1 ||
    result.id.length > 256
  ) {
    throw new Error("QINIU_FETCH_NOT_ACCEPTED");
  }

  for (let attempt = 0; attempt < QINIU_FETCH_POLL_ATTEMPTS; attempt += 1) {
    const status = await qiniuRequest<QiniuFetchTask>(
      config,
      "GET",
      `/sisyphus/fetch?id=${encodeURIComponent(result.id)}`
    ).catch(() => null);
    if (status && status.wait === -1) return;
    await new Promise((resolve) =>
      setTimeout(resolve, QINIU_FETCH_POLL_DELAY_MS)
    );
  }
}

export function createQiniuAudioCache(
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void
): AudioCacheLike | null {
  const config = normalizeConfig(env);
  return config ? new QiniuAudioCache(env, config, waitUntil) : null;
}

class QiniuAudioCache implements AudioCacheLike {
  constructor(
    private readonly env: Env,
    private readonly config: QiniuAudioCacheConfig,
    private readonly waitUntil: (promise: Promise<unknown>) => void
  ) {}

  async lookup(
    track: AudioCacheTrackReference
  ): Promise<AudioCacheLookupResult | null> {
    const hash = await hashTargetKey(canonicalTargetKey(track));
    const record = await this.readRecord(hash);
    if (!record || record.state !== "ready") return null;
    return {
      path: `/music-api/cache/audio?key=${hash}`,
      storedBr: record.storedBr,
    };
  }

  async serve(
    cacheKey: string,
    range?: string | null
  ): Promise<Response | null> {
    if (!/^[a-f0-9]{64}$/.test(cacheKey) || !isValidRange(range)) return null;
    const record = await this.readRecord(cacheKey);
    if (!record || record.state !== "ready") return null;

    const url = await privateDownloadUrl(this.config, record.objectKey);
    const response = await fetch(url, {
      headers: range ? { Range: range } : undefined,
    }).catch(() => null);
    if (!response) return null;
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404) await this.deleteRecord(cacheKey);
      return null;
    }

    const headers = new Headers();
    headers.set(
      "Content-Type",
      normalizeContentType(response.headers.get("Content-Type"))
    );
    const contentLength = response.headers.get("Content-Length");
    if (contentLength && /^\d{1,20}$/.test(contentLength)) {
      headers.set("Content-Length", BigInt(contentLength).toString());
    }
    const contentRange = response.headers.get("Content-Range");
    if (
      contentRange &&
      /^bytes \d{1,20}-\d{1,20}\/\d{1,20}$/.test(contentRange)
    ) {
      headers.set("Content-Range", contentRange);
    }
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "private, max-age=86400");
    headers.set("Pragma", "no-cache");
    headers.set("Vary", "Range");
    headers.set("ETag", `"${cacheKey}"`);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  }

  async startNeteasePlaylistJob(
    playlistId: string,
    credential: string
  ): Promise<AudioCacheJobStatus> {
    if (!isSafePlaylistId(playlistId))
      throw new TypeError("Invalid NetEase playlist ID");
    const normalizedPlaylistId = normalizeId(playlistId);
    const activeId = await this.env.oh_file_url.get(
      activePlaylistKey(normalizedPlaylistId)
    );
    if (typeof activeId === "string") {
      const existing = await this.getJob(activeId);
      if (
        existing &&
        (existing.state === "queued" || existing.state === "running")
      ) {
        return existing;
      }
    }

    const job: QiniuAudioCacheJob = {
      jobId: crypto.randomUUID().replace(/-/g, ""),
      playlistId: normalizedPlaylistId,
      state: "queued",
      total: 0,
      processed: 0,
      cached: 0,
      skipped: 0,
      failed: 0,
    };
    await this.writeJob(job);
    await this.env.oh_file_url.put(
      activePlaylistKey(normalizedPlaylistId),
      job.jobId,
      { expirationTtl: JOB_TTL_SECONDS }
    );
    this.waitUntil(this.runJob(job, credential));
    return publicJob(job);
  }

  async cacheNeteaseTrack(
    track: AudioCacheNeteaseTrack,
    credential: string
  ): Promise<AudioCacheTrackState> {
    const target: QiniuPlaylistTrack = {
      id: normalizeId(track.id),
      urlId: normalizeId(track.urlId ?? track.id),
      name: track.name,
      artist: track.artist,
      ...(track.duration &&
      Number.isFinite(track.duration) &&
      track.duration > 0
        ? { duration: track.duration }
        : {}),
    };
    if (!/^\d{1,20}$/.test(target.id) || !isSafeCacheTrack(target)) {
      throw new TypeError("Invalid NetEase track");
    }
    const hash = await hashTargetKey(
      canonicalTargetKey({ source: "_netease", id: target.id })
    );
    if (await this.readRecord(hash)) return "cached";
    const inflightKey = activeTrackKey(hash);
    if ((await this.env.oh_file_url.get(inflightKey)) !== null)
      return "pending";
    await this.env.oh_file_url.put(inflightKey, "1", {
      expirationTtl: ACTIVE_TRACK_TTL_SECONDS,
    });
    this.waitUntil(
      this.prefetchTrack(target, credential)
        .catch(() => "failed" as const)
        .finally(() =>
          this.env.oh_file_url.delete(inflightKey).catch(() => undefined)
        )
    );
    return "queued";
  }

  /**
   * Bounded, resumable playlist sync meant to be called repeatedly (cron or on
   * app open). Each call does at most a few seconds / subrequests of work:
   *   1. already cached or known-unavailable tracks are skipped (KV only);
   *   2. submitted downloads are verified with one probe and marked ready;
   *   3. new tracks get a complete (non-trial) source submitted to Qiniu.
   * Tracks that repeatedly have no source are recorded as unavailable so the
   * client can hide them.
   */
  async syncNeteasePlaylist(
    playlistId: string,
    credential: string,
    budget: { timeMs?: number; subrequests?: number } = {}
  ): Promise<AudioCacheSyncResult> {
    if (!isSafePlaylistId(playlistId)) {
      throw new TypeError("Invalid NetEase playlist ID");
    }
    const normalizedPlaylistId = normalizeId(playlistId);
    const deadline =
      Date.now() + (budget.timeMs ?? SYNC_DEFAULT_TIME_BUDGET_MS);
    let subrequestsLeft = budget.subrequests ?? SYNC_DEFAULT_SUBREQUEST_BUDGET;
    const spend = (count: number) => {
      if (subrequestsLeft < count || Date.now() > deadline) return false;
      subrequestsLeft -= count;
      return true;
    };

    const tracks = await this.loadSyncTracks(normalizedPlaylistId, credential);
    subrequestsLeft -= 2;

    const result: AudioCacheSyncResult = {
      total: tracks.length,
      ready: 0,
      pending: 0,
      submitted: 0,
      unavailable: [],
      remaining: 0,
    };

    for (const track of tracks) {
      const hash = await hashTargetKey(
        canonicalTargetKey({ source: "_netease", id: track.id })
      );
      if (await this.readRecord(hash)) {
        result.ready += 1;
        continue;
      }

      const miss = await this.readMiss(hash);
      if (miss && miss.rounds >= MISS_ROUNDS_BEFORE_UNAVAILABLE) {
        result.unavailable.push(track.id);
        continue;
      }

      const pending = await this.readPending(hash);
      if (pending) {
        const age = Date.now() - pending.submittedAt;
        if (age < PENDING_VERIFY_AFTER_MS || !spend(1)) {
          result.pending += 1;
          continue;
        }
        const ready = await probeObject(this.config, pending.objectKey);
        if (ready) {
          await this.writeReadyRecord(
            hash,
            canonicalTargetKey({ source: "_netease", id: track.id }),
            pending.objectKey,
            pending.br,
            ready
          );
          await this.env.oh_file_url.delete(PENDING_KEY_PREFIX + hash);
          result.ready += 1;
          continue;
        }
        if (age < PENDING_GIVE_UP_AFTER_MS) {
          result.pending += 1;
          continue;
        }
        // The download never landed: count it as a failed round and retry.
        await this.env.oh_file_url.delete(PENDING_KEY_PREFIX + hash);
        await this.recordMiss(hash, miss);
        result.remaining += 1;
        continue;
      }

      // Budget for one submit: NetEase URL + Qiniu submit, and up to 4 more
      // for the generic fallback (2 searches + URL).
      if (!spend(2)) {
        result.remaining += 1;
        continue;
      }
      const objectKeyValue = objectKey(this.config, hash);
      // Quality ladder: 320k first, then 192k, then 128k. Trial clips are
      // rejected, so only complete songs are ever stored.
      let source = await resolveNeteaseSource(track, 320, credential);
      if (!source && spend(2)) {
        const alternatives = (
          await Promise.all(
            GENERIC_SOURCES.map((genericSource) =>
              genericSearch(genericSource, track)
            )
          )
        )
          .flat()
          .filter(
            (candidate) =>
              candidate.source === "joox" || candidate.source === "kuwo"
          );
        const best = alternatives[0];
        if (best) {
          for (const br of CACHE_QUALITIES) {
            if (!spend(1)) break;
            const url = await genericUrl(
              best.source as GenericSource,
              best.urlId,
              br
            );
            if (url) {
              source = { url, br };
              break;
            }
          }
        }
      }

      if (!source) {
        const rounds = await this.recordMiss(hash, miss);
        if (rounds >= MISS_ROUNDS_BEFORE_UNAVAILABLE) {
          result.unavailable.push(track.id);
        } else {
          result.remaining += 1;
        }
        continue;
      }

      if (await submitQiniuFetch(this.config, source.url, objectKeyValue)) {
        await this.env.oh_file_url.put(
          PENDING_KEY_PREFIX + hash,
          JSON.stringify({
            objectKey: objectKeyValue,
            br: source.br,
            submittedAt: Date.now(),
          }),
          { expirationTtl: 24 * 60 * 60 }
        );
        result.submitted += 1;
        result.pending += 1;
      } else {
        result.remaining += 1;
      }
    }

    await this.env.oh_file_url.put(
      PLAYLIST_STATUS_KEY_PREFIX + normalizedPlaylistId,
      JSON.stringify({ ...result, updatedAt: Date.now() }),
      { expirationTtl: MISS_TTL_SECONDS }
    );
    return result;
  }

  async getPlaylistStatus(
    playlistId: string
  ): Promise<(AudioCacheSyncResult & { updatedAt: number }) | null> {
    if (!isSafePlaylistId(playlistId)) return null;
    const value = await this.env.oh_file_url.get(
      PLAYLIST_STATUS_KEY_PREFIX + normalizeId(playlistId),
      { type: "json" }
    );
    return value && typeof value === "object"
      ? (value as AudioCacheSyncResult & { updatedAt: number })
      : null;
  }

  private async readPending(
    hash: string
  ): Promise<{ objectKey: string; br: number; submittedAt: number } | null> {
    const value = await this.env.oh_file_url.get(PENDING_KEY_PREFIX + hash, {
      type: "json",
    });
    if (!value || typeof value !== "object") return null;
    const pending = value as {
      objectKey?: unknown;
      br?: unknown;
      submittedAt?: unknown;
    };
    return typeof pending.objectKey === "string" &&
      pending.objectKey.startsWith(`${this.config.objectPrefix}/`) &&
      typeof pending.br === "number" &&
      typeof pending.submittedAt === "number"
      ? (pending as { objectKey: string; br: number; submittedAt: number })
      : null;
  }

  private async readMiss(hash: string): Promise<{ rounds: number } | null> {
    const value = await this.env.oh_file_url.get(MISS_KEY_PREFIX + hash, {
      type: "json",
    });
    return value &&
      typeof value === "object" &&
      typeof (value as { rounds?: unknown }).rounds === "number"
      ? (value as { rounds: number })
      : null;
  }

  private async recordMiss(
    hash: string,
    previous: { rounds: number } | null
  ): Promise<number> {
    const rounds = (previous?.rounds ?? 0) + 1;
    await this.env.oh_file_url.put(
      MISS_KEY_PREFIX + hash,
      JSON.stringify({ rounds, at: Date.now() }),
      { expirationTtl: MISS_TTL_SECONDS }
    );
    return rounds;
  }

  async getJob(jobId: string): Promise<AudioCacheJobStatus | null> {
    if (!/^[a-f0-9]{32}$/.test(jobId)) return null;
    const value = await this.env.oh_file_url.get(jobKey(jobId), {
      type: "json",
    });
    if (!value || typeof value !== "object") return null;
    return publicJob(value as QiniuAudioCacheJob);
  }

  private async readRecord(hash: string): Promise<QiniuCacheRecord | null> {
    const value = await this.env.oh_file_url.get(cacheKeyForHash(hash), {
      type: "json",
    });
    if (!value || typeof value !== "object") return null;
    const record = value as Partial<QiniuCacheRecord>;
    return record.version === 1 &&
      record.state === "ready" &&
      typeof record.targetKey === "string" &&
      typeof record.objectKey === "string" &&
      record.objectKey.startsWith(`${this.config.objectPrefix}/`) &&
      typeof record.storedBr === "number"
      ? (record as QiniuCacheRecord)
      : null;
  }

  private async deleteRecord(hash: string): Promise<void> {
    await this.env.oh_file_url.delete(cacheKeyForHash(hash));
  }

  private async writeJob(job: QiniuAudioCacheJob): Promise<void> {
    await this.env.oh_file_url.put(jobKey(job.jobId), JSON.stringify(job), {
      expirationTtl: JOB_TTL_SECONDS,
    });
  }

  private async runJob(
    job: QiniuAudioCacheJob,
    credential: string
  ): Promise<void> {
    let credentialForRun = credential;
    try {
      job.state = "running";
      job.startedAt = Date.now();
      const tracks = await this.loadPlaylistTracks(
        job.playlistId,
        credentialForRun
      );
      job.total = tracks.length;
      await this.writeJob(job);

      let cursor = 0;
      const worker = async () => {
        while (cursor < tracks.length) {
          const index = cursor;
          cursor += 1;
          const outcome = await this.prefetchTrack(
            tracks[index],
            credentialForRun
          );
          job.processed += 1;
          if (outcome === "cached") job.cached += 1;
          else if (outcome === "skipped") job.skipped += 1;
          else job.failed += 1;
          await this.writeJob(job);
        }
      };

      await Promise.all(
        Array.from(
          {
            length: Math.min(CACHE_JOB_CONCURRENCY, Math.max(1, tracks.length)),
          },
          () => worker()
        )
      );
      job.state = "completed";
      if (job.failed > 0) job.error = "部分歌曲没有可用的合规音源";
    } catch {
      job.state = "failed";
      job.error = "网易云歌单缓存任务失败";
    } finally {
      credentialForRun = "";
      job.finishedAt = Date.now();
      await this.writeJob(job).catch(() => undefined);
      await this.env.oh_file_url
        .delete(activePlaylistKey(job.playlistId))
        .catch(() => undefined);
    }
  }

  /**
   * Track list for the sync: the first page (newest likes) is always read
   * fresh; the rest comes from a saved copy refreshed every few hours, so a
   * run does not spend its whole time budget re-reading 300+ songs.
   */
  private async loadSyncTracks(
    playlistId: string,
    credential: string
  ): Promise<QiniuPlaylistTrack[]> {
    const key = PLAYLIST_TRACKS_KEY_PREFIX + playlistId;
    const saved = (await this.env.oh_file_url.get(key, { type: "json" })) as {
      tracks?: QiniuPlaylistTrack[];
      at?: number;
    } | null;
    const savedTracks = Array.isArray(saved?.tracks) ? saved.tracks : null;
    if (
      !savedTracks ||
      typeof saved?.at !== "number" ||
      Date.now() - saved.at > PLAYLIST_TRACKS_FULL_REFRESH_MS
    ) {
      const full = await this.loadPlaylistTracks(playlistId, credential);
      await this.env.oh_file_url.put(
        key,
        JSON.stringify({ tracks: full, at: Date.now() })
      );
      return full;
    }

    const firstPage = await getPlaylistDetailPreferAnonymous(
      playlistId,
      credential,
      { offset: 0, limit: NETEASE_PLAYLIST_PAGE_SIZE }
    );
    const fresh = (firstPage.tracks ?? [])
      .map((song) => toCacheTrack(song))
      .filter((track): track is QiniuPlaylistTrack => track !== null);
    const freshIds = new Set(fresh.map((track) => track.id));
    return [
      ...fresh,
      ...savedTracks.filter((track) => !freshIds.has(track.id)),
    ];
  }

  private async loadPlaylistTracks(
    playlistId: string,
    credential: string
  ): Promise<QiniuPlaylistTrack[]> {
    const tracks: QiniuPlaylistTrack[] = [];
    const seen = new Set<string>();
    let offset = 0;
    for (
      let page = 0;
      page <= NETEASE_PLAYLIST_MAX_TOTAL_TRACKS / NETEASE_PLAYLIST_PAGE_SIZE;
      page += 1
    ) {
      const detail = await getPlaylistDetailPreferAnonymous(
        playlistId,
        credential,
        {
          offset,
          limit: NETEASE_PLAYLIST_PAGE_SIZE,
        }
      );
      for (const song of detail.tracks ?? []) {
        const track = toCacheTrack(song);
        if (!track || seen.has(track.id)) continue;
        seen.add(track.id);
        tracks.push(track);
      }
      if (!detail.hasMore) return tracks;
      const nextOffset = detail.nextOffset;
      if (
        typeof nextOffset !== "number" ||
        !Number.isSafeInteger(nextOffset) ||
        nextOffset <= offset ||
        nextOffset > NETEASE_PLAYLIST_MAX_TOTAL_TRACKS
      ) {
        throw new Error("Invalid playlist continuation");
      }
      offset = nextOffset;
    }
    throw new Error("Playlist exceeded cache safety cap");
  }

  private async prefetchTrack(
    target: QiniuPlaylistTrack,
    credential: string
  ): Promise<"cached" | "skipped" | "failed"> {
    const targetReference: AudioCacheTrackReference = {
      source: "_netease",
      id: target.id,
      urlId: target.urlId,
    };
    const hash = await hashTargetKey(canonicalTargetKey(targetReference));
    if (await this.readRecord(hash)) return "skipped";
    const objectKeyValue = objectKey(this.config, hash);

    const candidates: QiniuCacheCandidate[] = [
      {
        source: "_netease",
        id: target.id,
        urlId: target.urlId,
        name: target.name,
        artist: target.artist,
        duration: target.duration,
      },
      {
        source: "netease",
        id: target.id,
        urlId: target.urlId,
        name: target.name,
        artist: target.artist,
        duration: target.duration,
      },
    ];

    let alternativesLoaded = false;

    for (const br of CACHE_QUALITIES) {
      for (const candidate of candidates) {
        const sourceUrl =
          candidate.source === "_netease"
            ? await resolveNeteaseUrl(target, br, credential)
            : await genericUrl(candidate.source, candidate.urlId, br);
        if (!sourceUrl) continue;
        try {
          await startQiniuFetch(this.config, sourceUrl, objectKeyValue);
          const ready = await waitForObject(this.config, objectKeyValue);
          if (!ready) continue;
          await this.writeReadyRecord(
            hash,
            canonicalTargetKey(targetReference),
            objectKeyValue,
            br,
            ready
          );
          return "cached";
        } catch {
          // Continue with the next bounded source/quality fallback.
        }
      }

      if (br === 320 && !alternativesLoaded) {
        alternativesLoaded = true;
        const alternatives = await Promise.all(
          GENERIC_SOURCES.map((source) => genericSearch(source, target))
        );
        const candidateKeys = new Set(
          candidates.map(
            (candidate) => `${candidate.source}:${candidate.urlId}`
          )
        );
        for (const candidate of alternatives.flat()) {
          const key = `${candidate.source}:${candidate.urlId}`;
          if (candidateKeys.has(key)) continue;
          candidateKeys.add(key);
          candidates.push(candidate);
        }

        for (const candidate of candidates.slice(2)) {
          if (candidate.source !== "joox" && candidate.source !== "kuwo") {
            continue;
          }
          const sourceUrl = await genericUrl(
            candidate.source,
            candidate.urlId,
            br
          );
          if (!sourceUrl) continue;
          try {
            await startQiniuFetch(this.config, sourceUrl, objectKeyValue);
            const ready = await waitForObject(this.config, objectKeyValue);
            if (!ready) continue;
            await this.writeReadyRecord(
              hash,
              canonicalTargetKey(targetReference),
              objectKeyValue,
              br,
              ready
            );
            return "cached";
          } catch {
            // Continue with the next bounded generic candidate.
          }
        }
      }
    }
    return "failed";
  }

  private async writeReadyRecord(
    hash: string,
    targetKey: string,
    objectKeyValue: string,
    storedBr: number,
    ready: { contentType: string; byteSize?: number }
  ): Promise<void> {
    const record: QiniuCacheRecord = {
      version: 1,
      state: "ready",
      targetKey,
      objectKey: objectKeyValue,
      storedBr,
      contentType: ready.contentType,
      ...(ready.byteSize === undefined ? {} : { byteSize: ready.byteSize }),
      createdAt: Date.now(),
    };
    await this.env.oh_file_url.put(
      cacheKeyForHash(hash),
      JSON.stringify(record)
    );
  }
}
