import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
} from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Readable, Transform } from "node:stream";
import type {
  AudioCacheJobStatus,
  AudioCacheLike,
  AudioCacheLookupResult,
  AudioCacheTrackReference,
} from "../functions/types/hono";
import {
  fetchUpstreamWithDeadline,
  type SongDetail,
} from "@otter-music/shared";
import { getPlaylistDetail, getSongUrl } from "../functions/utils/music/netease-api";
import { proxyPrivateAudio } from "../functions/utils/proxy/audio";

const GENERIC_MUSIC_API_URL = "https://music-api.gdstudio.xyz/api.php";
const GENERIC_SOURCES = ["joox", "kuwo"] as const;
const CACHE_QUALITIES = [320, 192, 128] as const;
const CACHE_PAGE_SIZE = 100;
const CACHE_JOB_CONCURRENCY = 3;
const CACHE_MAX_TOTAL_TRACKS = 20_000;
const CACHE_MAX_BYTES = 150 * 1024 * 1024;
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CACHE_ID_PATTERN = /^[A-Za-z0-9._~:+/=-]{1,256}$/;
const NETEASE_PLAYLIST_ID_PATTERN = /^(?:(?:neplaylist|ne_playlist)_)?\d{1,20}$/;

type GenericSource = "netease" | (typeof GENERIC_SOURCES)[number];
type CacheProviderSource = "_netease" | GenericSource;

interface CacheTrack extends AudioCacheTrackReference {
  name: string;
  artist: string[];
  album: string;
  duration?: number;
}

interface CacheCandidate {
  source: CacheProviderSource;
  id: string;
  urlId: string;
  name: string;
  artist: string[];
  duration?: number;
}

interface CacheRow {
  cache_key: string;
  target_key: string;
  target_source: string;
  target_id: string;
  target_url_id: string | null;
  provider_source: string;
  provider_id: string;
  stored_br: number;
  content_type: string;
  file_name: string;
  byte_size: number;
  created_at: number;
  last_accessed_at: number;
}

interface InternalJob extends AudioCacheJobStatus {
  playlistId: string;
}

function normalizeId(value: string): string {
  return value.replace(
    /^(?:neplaylist_|ne_playlist_|netrack_|ne_track_)/,
    ""
  );
}

function canonicalTargetKey(track: AudioCacheTrackReference): string {
  const id = normalizeId(track.id);
  if (
    (track.source === "_netease" || track.source === "netease") &&
    /^\d{1,20}$/.test(id)
  ) {
    // The official and backup NetEase providers address the same recording.
    return `netease:${id}`;
  }
  return `${track.source}:${id}:${track.urlId ?? ""}`;
}

function hashTargetKey(targetKey: string): string {
  return createHash("sha256").update(targetKey).digest("hex");
}

function normalizeMatchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function isTrackMatch(target: CacheTrack, candidate: CacheCandidate): boolean {
  if (normalizeMatchText(target.name) !== normalizeMatchText(candidate.name)) {
    return false;
  }

  const targetArtists = target.artist
    .map(normalizeMatchText)
    .filter(Boolean);
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

function providerHeaders(source: CacheProviderSource): Record<string, string> {
  if (source === "_netease" || source === "netease") {
    return {
      Referer: "https://music.163.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
  }
  if (source === "joox") {
    return {
      Referer: "https://www.joox.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
  }
  return {
    Referer: "https://www.kuwo.cn/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
}

function cacheFileContentType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() || "audio/mpeg";
}

function parseRange(
  value: string | null | undefined,
  size: number
): { start: number; end: number } | "invalid" | null {
  if (value === null || value === undefined) return null;
  if (value.length > 64) return "invalid";
  const match = /^bytes=(\d{1,20})-(\d{0,20})$/.exec(value);
  if (!match) {
    const suffix = /^bytes=-(\d{1,20})$/.exec(value);
    if (!suffix) return "invalid";
    const length = Number(suffix[1]);
    if (!Number.isSafeInteger(length) || length < 1) return "invalid";
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

async function genericSearch(
  source: GenericSource,
  target: CacheTrack
): Promise<CacheCandidate[]> {
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
        ? rawArtist.filter((value): value is string => typeof value === "string")
        : typeof rawArtist === "string"
          ? [rawArtist]
          : [];
      if (!id || !CACHE_ID_PATTERN.test(id) || !name || !artist.length) {
        return [];
      }
      const duration =
        typeof record.duration === "number" &&
        Number.isFinite(record.duration) &&
        record.duration > 0
          ? record.duration
          : undefined;
      const candidate: CacheCandidate = {
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
  if (!CACHE_ID_PATTERN.test(id)) return null;
  const url = `${GENERIC_MUSIC_API_URL}?${new URLSearchParams({
    types: "url",
    source,
    id,
    br: String(br),
  }).toString()}`;
  try {
    return await fetchUpstreamWithDeadline(
      url,
      { headers: providerHeaders(source) },
      async (response) => {
        if (!response.ok) return null;
        const payload = (await response.json()) as {
          url?: unknown;
        };
        const candidate = payload?.url;
        return typeof candidate === "string" && candidate.length <= 4096
          ? candidate
          : null;
      },
      { responseType: "json", deadlineMs: 10_000 }
    );
  } catch {
    return null;
  }
}

function toCacheTrack(song: SongDetail): CacheTrack | null {
  if (!song || typeof song.id !== "number" || !Number.isSafeInteger(song.id)) {
    return null;
  }
  const artist = Array.isArray(song.ar)
    ? song.ar
        .map((item) => item?.name)
        .filter((value): value is string => typeof value === "string" && !!value)
    : [];
  const name = typeof song.name === "string" ? song.name : "";
  if (!name || !artist.length) return null;
  return {
    source: "_netease",
    id: String(song.id),
    urlId: String(song.id),
    name,
    artist,
    album: typeof song.al?.name === "string" ? song.al.name : "",
    duration:
      typeof song.dt === "number" && Number.isFinite(song.dt) && song.dt > 0
        ? song.dt / 1000
        : undefined,
  };
}

export class VpsAudioCache implements AudioCacheLike {
  private readonly directory: string;
  private readonly database: DatabaseSync;
  private readonly jobs = new Map<string, InternalJob>();
  private readonly activePlaylists = new Map<string, string>();

  constructor(dataDir: string) {
    this.directory = join(dataDir, "audio-cache");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);

    this.database = new DatabaseSync(join(this.directory, "index.sqlite"));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS audio_cache (
        cache_key TEXT PRIMARY KEY,
        target_key TEXT NOT NULL UNIQUE,
        target_source TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_url_id TEXT,
        provider_source TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        stored_br INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audio_cache_target_idx
        ON audio_cache (target_source, target_id);
    `);
    chmodSync(join(this.directory, "index.sqlite"), 0o600);
  }

  async lookup(
    track: AudioCacheTrackReference
  ): Promise<AudioCacheLookupResult | null> {
    const targetKey = canonicalTargetKey(track);
    const row = this.database
      .prepare("SELECT * FROM audio_cache WHERE target_key = ?")
      .get(targetKey) as unknown as CacheRow | undefined;
    if (!row || !CACHE_KEY_PATTERN.test(row.cache_key)) return null;

    const filePath = join(this.directory, row.file_name);
    try {
      const file = await stat(filePath);
      if (file.size <= 0 || file.size > CACHE_MAX_BYTES) throw new Error("invalid file");
    } catch {
      this.database
        .prepare("DELETE FROM audio_cache WHERE cache_key = ?")
        .run(row.cache_key);
      await rm(filePath, { force: true }).catch(() => undefined);
      return null;
    }

    this.database
      .prepare("UPDATE audio_cache SET last_accessed_at = ? WHERE cache_key = ?")
      .run(Date.now(), row.cache_key);
    return {
      path: `/music-api/cache/audio?key=${row.cache_key}`,
      storedBr: row.stored_br,
    };
  }

  async serve(cacheKey: string, range?: string | null): Promise<Response | null> {
    if (!CACHE_KEY_PATTERN.test(cacheKey)) return null;
    const row = this.database
      .prepare("SELECT * FROM audio_cache WHERE cache_key = ?")
      .get(cacheKey) as unknown as CacheRow | undefined;
    if (!row) return null;

    const filePath = join(this.directory, row.file_name);
    let fileSize: number;
    try {
      fileSize = (await stat(filePath)).size;
    } catch {
      return null;
    }
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > CACHE_MAX_BYTES) {
      return null;
    }

    const parsedRange = parseRange(range, fileSize);
    if (parsedRange === "invalid") {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${fileSize}`,
          "Cache-Control": "private, no-store, max-age=0",
        },
      });
    }

    const start = parsedRange?.start ?? 0;
    const end = parsedRange?.end ?? fileSize - 1;
    const status = parsedRange ? 206 : 200;
    const stream = createReadStream(filePath, { start, end });
    const headers = new Headers({
      "Content-Type": cacheFileContentType(row.content_type),
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=86400",
      Pragma: "no-cache",
      Vary: "Range",
      ETag: `"${row.cache_key}"`,
      "X-Content-Type-Options": "nosniff",
    });
    if (parsedRange) {
      headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    }

    this.database
      .prepare("UPDATE audio_cache SET last_accessed_at = ? WHERE cache_key = ?")
      .run(Date.now(), row.cache_key);
    return new Response(
      Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      { status, headers }
    );
  }

  async startNeteasePlaylistJob(
    playlistId: string,
    credential: string
  ): Promise<AudioCacheJobStatus> {
    if (!NETEASE_PLAYLIST_ID_PATTERN.test(playlistId)) {
      throw new TypeError("Invalid NetEase playlist ID");
    }
    const existingId = this.activePlaylists.get(playlistId);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing) return this.publicJob(existing);
    }

    const job: InternalJob = {
      jobId: randomUUID().replace(/-/g, ""),
      playlistId,
      state: "queued",
      total: 0,
      processed: 0,
      cached: 0,
      skipped: 0,
      failed: 0,
    };
    this.jobs.set(job.jobId, job);
    this.activePlaylists.set(playlistId, job.jobId);
    void this.runPlaylistJob(job, credential);
    return this.publicJob(job);
  }

  getJob(jobId: string): AudioCacheJobStatus | null {
    if (!/^[a-f0-9]{32}$/.test(jobId)) return null;
    const job = this.jobs.get(jobId);
    return job ? this.publicJob(job) : null;
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private publicJob(job: InternalJob): AudioCacheJobStatus {
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

  private async runPlaylistJob(job: InternalJob, credential: string): Promise<void> {
    let credentialForRun = credential;
    try {
      job.state = "running";
      job.startedAt = Date.now();
      const tracks = await this.loadPlaylistTracks(job.playlistId, credentialForRun);
      job.total = tracks.length;
      let cursor = 0;
      const worker = async () => {
        while (cursor < tracks.length) {
          const index = cursor;
          cursor += 1;
          const result = await this.prefetchTrack(tracks[index], credentialForRun);
          job.processed += 1;
          if (result === "cached") job.cached += 1;
          else if (result === "skipped") job.skipped += 1;
          else job.failed += 1;
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(CACHE_JOB_CONCURRENCY, Math.max(1, tracks.length)) },
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
      if (this.activePlaylists.get(job.playlistId) === job.jobId) {
        this.activePlaylists.delete(job.playlistId);
      }
    }
  }

  private async loadPlaylistTracks(
    playlistId: string,
    credential: string
  ): Promise<CacheTrack[]> {
    const tracks: CacheTrack[] = [];
    const seen = new Set<string>();
    let offset = 0;

    for (let page = 0; page < CACHE_MAX_TOTAL_TRACKS / CACHE_PAGE_SIZE; page += 1) {
      const detail = await getPlaylistDetail(playlistId, credential, {
        offset,
        limit: CACHE_PAGE_SIZE,
      });
      for (const song of detail.tracks ?? []) {
        const track = toCacheTrack(song);
        if (!track) continue;
        const key = canonicalTargetKey(track);
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push(track);
      }

      if (!detail.hasMore) return tracks;
      const nextOffset = detail.nextOffset;
      if (
        typeof nextOffset !== "number" ||
        !Number.isSafeInteger(nextOffset) ||
        nextOffset <= offset ||
        nextOffset > CACHE_MAX_TOTAL_TRACKS
      ) {
        throw new Error("Invalid playlist continuation");
      }
      offset = nextOffset;
    }
    throw new Error("Playlist exceeded cache safety cap");
  }

  private async prefetchTrack(
    target: CacheTrack,
    credential: string
  ): Promise<"cached" | "skipped" | "failed"> {
    if (await this.lookup(target)) return "skipped";

    const candidates: CacheCandidate[] = [
      {
        source: "_netease",
        id: target.id,
        urlId: target.urlId ?? target.id,
        name: target.name,
        artist: target.artist,
        duration: target.duration,
      },
      {
        source: "netease",
        id: target.id,
        urlId: target.urlId ?? target.id,
        name: target.name,
        artist: target.artist,
        duration: target.duration,
      },
    ];

    let alternativesLoaded = false;
    for (const br of CACHE_QUALITIES) {
      for (const candidate of candidates) {
        try {
          const url = await this.resolveCandidateUrl(candidate, br, credential);
          if (!url) continue;
          const stored = await this.downloadCandidate(target, candidate, br, url);
          if (stored) return "cached";
        } catch {
          // A source/quality miss is expected during a bounded fallback walk.
        }
      }

      if (br === 320 && !alternativesLoaded) {
        alternativesLoaded = true;
        const alternatives = await Promise.all(
          GENERIC_SOURCES.map((source) => genericSearch(source, target))
        );
        const candidateKeys = new Set(
          candidates.map((candidate) => `${candidate.source}:${candidate.urlId}`)
        );
        for (const candidate of alternatives.flat()) {
          const key = `${candidate.source}:${candidate.urlId}`;
          if (candidateKeys.has(key)) continue;
          candidateKeys.add(key);
          candidates.push(candidate);
        }

        for (const candidate of candidates.slice(2)) {
          try {
            const url = await this.resolveCandidateUrl(candidate, br, credential);
            if (!url) continue;
            const stored = await this.downloadCandidate(target, candidate, br, url);
            if (stored) return "cached";
          } catch {
            // Continue with the next bounded candidate.
          }
        }
      }
    }
    return "failed";
  }

  private async resolveCandidateUrl(
    candidate: CacheCandidate,
    br: number,
    credential: string
  ): Promise<string | null> {
    if (candidate.source === "_netease") {
      const response = await getSongUrl(candidate.id, br * 1000, credential);
      return response?.data?.data?.[0]?.url ?? null;
    }
    return genericUrl(candidate.source, candidate.urlId, br);
  }

  private async downloadCandidate(
    target: CacheTrack,
    candidate: CacheCandidate,
    br: number,
    url: string
  ): Promise<boolean> {
    const response = await proxyPrivateAudio(url, providerHeaders(candidate.source));
    if (!response.body) return false;

    const targetKey = canonicalTargetKey(target);
    const cacheKey = hashTargetKey(targetKey);
    const fileName = `${cacheKey}.audio`;
    const filePath = join(this.directory, fileName);
    const tempPath = join(this.directory, `${cacheKey}.${randomUUID()}.part`);
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.byteLength;
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(
          response.body as unknown as NodeReadableStream<Uint8Array>
        ),
        counter,
        createWriteStream(tempPath, { flags: "wx", mode: 0o600 })
      );
      if (
        bytes <= 0 ||
        bytes > CACHE_MAX_BYTES ||
        (target.duration !== undefined &&
          target.duration >= 90 &&
          bytes < (target.duration * 128_000) / 8 * 0.25)
      ) {
        throw new Error("Audio response is too small for the target track");
      }

      await rename(tempPath, filePath);
      const now = Date.now();
      this.database
        .prepare(
          `INSERT INTO audio_cache (
             cache_key, target_key, target_source, target_id, target_url_id,
             provider_source, provider_id, stored_br, content_type, file_name,
             byte_size, created_at, last_accessed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(target_key) DO UPDATE SET
             cache_key = excluded.cache_key,
             target_source = excluded.target_source,
             target_id = excluded.target_id,
             target_url_id = excluded.target_url_id,
             provider_source = excluded.provider_source,
             provider_id = excluded.provider_id,
             stored_br = excluded.stored_br,
             content_type = excluded.content_type,
             file_name = excluded.file_name,
             byte_size = excluded.byte_size,
             created_at = excluded.created_at,
             last_accessed_at = excluded.last_accessed_at`
        )
        .run(
          cacheKey,
          targetKey,
          target.source,
          target.id,
          target.urlId ?? null,
          candidate.source,
          candidate.urlId,
          br,
          cacheFileContentType(response.headers.get("Content-Type") ?? "audio/mpeg"),
          fileName,
          bytes,
          now,
          now
        );
      return true;
    } catch {
      await rm(tempPath, { force: true }).catch(() => undefined);
      return false;
    }
  }
}
