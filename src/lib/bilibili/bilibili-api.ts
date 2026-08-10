import { getApiUrl } from "@/lib/api/config";
import { parseBilibiliTrackId } from "@shared/utils/music/bilibili";
import type { MusicTrack, SearchPageResult } from "@/types/music";
import type { AudioFormat } from "@shared/types/music";
import type { BilibiliSeriesMetaRaw } from "@shared/types/music-platforms";

const BILIBILI_PROXY_PREFIX = "/music-api/bilibili";
const NETWORK_TIMEOUT = 12000;

const bffUrl = (path: string) =>
  `${getApiUrl()}${BILIBILI_PROXY_PREFIX}${path}`;

async function postBff<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T | null> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (signal?.aborted) onCallerAbort();
  else signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = window.setTimeout(() => controller.abort(), NETWORK_TIMEOUT);

  try {
    throwIfAborted(controller.signal);
    const response = await fetch(bffUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    throwIfAborted(controller.signal);
    if (!response.ok) return null;
    const payload = (await response.json()) as T;
    throwIfAborted(controller.signal);
    return payload;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw Object.assign(new Error("BILIBILI_REQUEST_ABORTED"), {
    name: "AbortError",
  });
}

function buildAudioProxyUrl(bvid: string, cid?: number): string {
  const query = new URLSearchParams({ bvid });
  if (cid !== undefined) query.set("cid", String(cid));
  return bffUrl(`/audio?${query.toString()}`);
}

export async function getBilibiliCoverUrl(
  coverUrl: string
): Promise<string | null> {
  if (!coverUrl) return null;
  const query = new URLSearchParams({ url: coverUrl });
  return bffUrl(`/cover?${query.toString()}`);
}

export async function searchBilibiliVideos(
  keyword: string,
  page: number,
  rows = 20,
  signal?: AbortSignal
): Promise<SearchPageResult<MusicTrack>> {
  return (
    (await postBff<SearchPageResult<MusicTrack>>(
      "/search",
      {
        keyword,
        page,
        rows,
      },
      signal
    )) ?? { items: [], hasMore: false }
  );
}

export async function getBilibiliSongUrl(
  trackId: string,
  signal?: AbortSignal
): Promise<{
  url: string;
  format: AudioFormat;
} | null> {
  throwIfAborted(signal);
  const parsed = parseBilibiliTrackId(trackId);
  if (!parsed) return null;
  return {
    // The browser receives only a same-origin identifier. The Functions audio
    // route resolves the short-lived upstream signature server-side.
    url: buildAudioProxyUrl(parsed.bvid, parsed.cid),
    format: "m4s",
  };
}

export async function searchBilibiliCollections(
  keyword: string,
  page: number,
  rows = 20,
  signal?: AbortSignal
): Promise<SearchPageResult<MusicTrack>> {
  return (
    (await postBff<SearchPageResult<MusicTrack>>(
      "/search-collections",
      {
        keyword,
        page,
        rows,
      },
      signal
    )) ?? { items: [], hasMore: false }
  );
}

export async function getBilibiliCollectionDetail(
  albumId: string,
  page = 1,
  pageSize = 100
): Promise<{
  meta: BilibiliSeriesMetaRaw | null;
  tracks: MusicTrack[];
  total: number;
} | null> {
  return postBff("/collection-detail", { albumId, page, pageSize });
}

/** The BFF search response is already normalized; no browser-side API fanout. */
export async function enrichBilibiliSearchResults(
  tracks: MusicTrack[]
): Promise<MusicTrack[]> {
  return tracks;
}

/** Detailed upstream video metadata is intentionally not exposed to browsers. */
export async function getBilibiliVideoDetail(
  _trackId: string
): Promise<Record<string, unknown> | null> {
  return null;
}

/** Historical multi-part local routes remain safe but are no longer resolved. */
export async function getBilibiliMultiPDetail(_albumId: string): Promise<{
  meta: { name: string; cover: string };
  tracks: MusicTrack[];
  total: number;
} | null> {
  return null;
}
