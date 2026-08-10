import {
  BILIBILI_COVER_HOST_RE,
  buildBilibiliHeaders,
  buildBilibiliDurlPlayUrlPath,
  buildBilibiliPlayUrlPath,
  buildBilibiliSeasonsArchivesListPath,
  buildBilibiliSearchPath,
  buildBilibiliSeriesArchivesPath,
  buildBilibiliSeriesDetailPath,
  buildBilibiliViewPath,
  convertSeasonArchiveToMusicTrack,
  convertSeriesArchiveToMusicTrack,
  parseBilibiliAlbumId,
  parseBilibiliSeasonsArchivesList,
  parseBilibiliSearchResponse,
  parseBilibiliSeriesArchives,
  parseBilibiliSeriesDetail,
  selectBilibiliAudioUrls,
  selectBilibiliCid,
  selectBilibiliNativeDurlUrls,
  fetchUpstreamWithDeadline,
  MUSIC_UPSTREAM_DEADLINE_MS,
  type BilibiliSeasonsArchivesListResponse,
  type BilibiliSearchResponse,
  type BilibiliSearchVideoRaw,
  type BilibiliSeriesArchivesResponse,
  type BilibiliSeriesResponse,
  type BilibiliPlayUrlResponse,
  type BilibiliViewResponse,
  type MusicTrack,
  type SearchPageResult,
} from "@otter-music/shared";
import { safeFetch } from "../proxy/fetch";
import { proxyPrivateAudio } from "../proxy/audio";

const BILIBILI_BASE_URL = "https://api.bilibili.com";
export const BILIBILI_AUDIO_MAX_REQUESTS = 7;
export const BILIBILI_AUDIO_MAX_MEDIA_ATTEMPTS = 4;
export const BILIBILI_DASH_CANDIDATE_LIMIT = 3;

export interface BilibiliAudioRequestBudget {
  deadlineAt: number;
  requests: number;
  mediaAttempts: number;
  signal?: AbortSignal;
}

export function createBilibiliAudioRequestBudget(
  options: { deadlineMs?: number; signal?: AbortSignal } = {}
): BilibiliAudioRequestBudget {
  const deadlineMs = options.deadlineMs ?? MUSIC_UPSTREAM_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new TypeError("Bilibili audio deadline must be positive and finite");
  }
  return {
    deadlineAt: Date.now() + deadlineMs,
    requests: 0,
    mediaAttempts: 0,
    signal: options.signal,
  };
}

function consumeBilibiliAudioRequest(
  budget: BilibiliAudioRequestBudget,
  media = false
): number {
  if (budget.signal?.aborted) {
    throw (
      budget.signal.reason ??
      new DOMException("Bilibili audio request aborted", "AbortError")
    );
  }
  const remainingMs = budget.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Bilibili audio deadline exceeded");
  }
  if (budget.requests >= BILIBILI_AUDIO_MAX_REQUESTS) {
    throw new Error("Bilibili audio request budget exceeded");
  }
  if (media && budget.mediaAttempts >= BILIBILI_AUDIO_MAX_MEDIA_ATTEMPTS) {
    throw new Error("Bilibili audio media attempt budget exceeded");
  }
  budget.requests += 1;
  if (media) budget.mediaAttempts += 1;
  return remainingMs;
}

async function fetchBilibiliJson<T>(
  path: string,
  referer?: string,
  budget?: BilibiliAudioRequestBudget
): Promise<T> {
  const remainingMs = budget ? consumeBilibiliAudioRequest(budget) : undefined;
  return fetchUpstreamWithDeadline(
    `${BILIBILI_BASE_URL}${path}`,
    {
      headers: buildBilibiliHeaders(referer),
      signal: budget?.signal,
    },
    async (response) => {
      if (!response.ok)
        throw new Error(`Bilibili API error: ${response.status}`);
      return response.json() as Promise<T>;
    },
    { responseType: "json", deadlineMs: remainingMs }
  );
}

export async function fetchBilibiliSearch(
  keyword: string,
  page: number,
  rows = 20
): Promise<SearchPageResult<MusicTrack>> {
  const data = await fetchBilibiliJson<BilibiliSearchResponse>(
    buildBilibiliSearchPath(keyword, page, rows)
  );

  const result = parseBilibiliSearchResponse(data, page, rows);
  const albums = extractCollectionsFromSearch(data.data?.result || []);

  return {
    items: [...albums, ...result.items],
    hasMore: result.hasMore,
  };
}

export async function fetchBilibiliSongUrl(
  bvid: string,
  cidOverride?: number
): Promise<string | null> {
  return (await fetchBilibiliSongUrls(bvid, cidOverride))[0] ?? null;
}

export interface BilibiliDashCandidates {
  cid: number;
  urls: string[];
}

export async function fetchBilibiliDashCandidates(
  bvid: string,
  cidOverride?: number,
  budget = createBilibiliAudioRequestBudget()
): Promise<BilibiliDashCandidates | null> {
  const referer = `https://www.bilibili.com/video/${bvid}`;
  let cid = cidOverride;

  if (!cid) {
    const view = await fetchBilibiliJson<BilibiliViewResponse>(
      buildBilibiliViewPath(bvid),
      referer,
      budget
    );
    cid = selectBilibiliCid(view) ?? undefined;
  }
  if (!cid) return null;

  const playUrl = await fetchBilibiliJson<BilibiliPlayUrlResponse>(
    buildBilibiliPlayUrlPath(bvid, cid),
    referer,
    budget
  );
  const urls = selectBilibiliAudioUrls(playUrl)
    .filter((candidate) => candidate.format !== "flv")
    .map((candidate) => candidate.url)
    .slice(0, BILIBILI_DASH_CANDIDATE_LIMIT);
  return { cid, urls };
}

export async function fetchBilibiliDurlSongUrls(
  bvid: string,
  cid: number,
  budget = createBilibiliAudioRequestBudget()
): Promise<string[]> {
  const durl = await fetchBilibiliJson<BilibiliPlayUrlResponse>(
    buildBilibiliDurlPlayUrlPath(bvid, cid),
    `https://www.bilibili.com/video/${bvid}`,
    budget
  );
  return selectBilibiliNativeDurlUrls(durl);
}

export async function fetchBilibiliSongUrls(
  bvid: string,
  cidOverride?: number,
  budget = createBilibiliAudioRequestBudget()
): Promise<string[]> {
  const dash = await fetchBilibiliDashCandidates(bvid, cidOverride, budget);
  if (!dash) return [];
  if (dash.urls.length) return dash.urls;
  return fetchBilibiliDurlSongUrls(bvid, dash.cid, budget);
}

export async function proxyBilibiliAudio(
  bvid: string,
  url: string,
  range?: string | null,
  budget?: BilibiliAudioRequestBudget
): Promise<Response> {
  if (budget) consumeBilibiliAudioRequest(budget, true);
  const response = await proxyPrivateAudio(
    url,
    buildBilibiliHeaders(`https://www.bilibili.com/video/${bvid}`),
    range,
    budget
      ? { deadlineAt: budget.deadlineAt, signal: budget.signal }
      : undefined
  );
  if (
    response.headers.get("content-type") === "application/octet-stream" &&
    !/\.(?:aac|m4a|m4s|mp3|mp4|ogg|webm)$/i.test(new URL(url).pathname)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Bilibili binary response has no playable media type");
  }
  return response;
}

/**
 * 从视频搜索结果中提取唯一的系列/合集。
 */
function extractCollectionsFromSearch(
  _results: BilibiliSearchVideoRaw[]
): MusicTrack[] {
  return [];
}

export async function fetchBilibiliSearchCollections(
  keyword: string,
  page: number,
  rows = 20
): Promise<SearchPageResult<MusicTrack>> {
  const data = await fetchBilibiliJson<BilibiliSearchResponse>(
    buildBilibiliSearchPath(keyword, page, rows)
  );

  if (!data || data.code !== 0) return { items: [], hasMore: false };

  const results = (data.data?.result || []).filter((v) => v.bvid);
  return {
    items: extractCollectionsFromSearch(results),
    hasMore: false,
  };
}

export async function fetchBilibiliCollectionDetail(
  albumId: string,
  page = 1,
  pageSize = 30
): Promise<{ meta: unknown; tracks: MusicTrack[]; total: number } | null> {
  const parsed = parseBilibiliAlbumId(albumId);
  if (parsed) {
    const seriesId = Number(parsed.seriesId);
    if (!isNaN(seriesId)) {
      const mid = parsed.mid ? Number(parsed.mid) : undefined;

      const [detailData, archivesData] = await Promise.all([
        fetchBilibiliJson<BilibiliSeriesResponse>(
          buildBilibiliSeriesDetailPath(seriesId)
        ),
        fetchBilibiliJson<BilibiliSeriesArchivesResponse>(
          buildBilibiliSeriesArchivesPath(seriesId, page, pageSize)
        ),
      ]);

      const meta = detailData ? parseBilibiliSeriesDetail(detailData) : null;

      if (meta) {
        const parsed = archivesData
          ? parseBilibiliSeriesArchives(archivesData)
          : { archives: [], total: 0 };

        return {
          meta,
          tracks: parsed.archives.map((archive) =>
            convertSeriesArchiveToMusicTrack(archive, albumId)
          ),
          total: parsed.total,
        };
      }

      if (mid !== undefined && !isNaN(mid)) {
        const seasonsData =
          await fetchBilibiliJson<BilibiliSeasonsArchivesListResponse>(
            buildBilibiliSeasonsArchivesListPath(mid, seriesId, page, pageSize)
          );

        if (seasonsData) {
          const seasonsResult = parseBilibiliSeasonsArchivesList(seasonsData);
          if (seasonsResult.meta) {
            return {
              meta: seasonsResult.meta,
              tracks: seasonsResult.archives.map((archive) =>
                convertSeasonArchiveToMusicTrack(archive, undefined, albumId)
              ),
              total: seasonsResult.total,
            };
          }
        }
      }
    }
  }

  return null;
}

export async function proxyBilibiliCover(url: string): Promise<Response> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    parsed.hash ||
    !BILIBILI_COVER_HOST_RE.test(parsed.hostname)
  ) {
    return new Response(JSON.stringify({ error: "invalid cover host" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  }

  const response = await safeFetch(
    url,
    buildBilibiliHeaders("https://www.bilibili.com/")
  );
  const contentType = response.headers.get("Content-Type")?.trim() || "";
  if (!/^image\/(?:avif|bmp|gif|jpeg|png|webp)(?:;|$)/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    return new Response(JSON.stringify({ error: "invalid cover type" }), {
      status: 415,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const responseHeaders = new Headers();
  for (const name of [
    "Content-Type",
    "Content-Length",
    "ETag",
    "Last-Modified",
  ]) {
    const value = response.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Content-Security-Policy", "sandbox; default-src 'none'");
  responseHeaders.set(
    "Cache-Control",
    parsed.search || response.status !== 200
      ? "private, no-store, max-age=0"
      : "public, max-age=86400, immutable"
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
