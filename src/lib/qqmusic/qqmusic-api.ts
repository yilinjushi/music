import type { MusicTrack, SearchPageResult, SongLyric } from "@/types/music";
import {
  buildQqPlaylistApiPath,
  convertQqSongToMusicTrack,
  parseQqPlaylistResponse,
} from "@shared/utils/music/qqmusic";
import type { QqPlaylistDetail } from "@shared/types/music-platforms";
import { getApiUrl } from "@/lib/api/config";

const QQ_PROXY_PREFIX = "/music-api/qqmusic";
const NETWORK_TIMEOUT = 12000;

export function parseQqMusicUrl(urlStr: string): string | null {
  try {
    const url = new URL(
      urlStr.startsWith("http") ? urlStr : `https://${urlStr}`
    );
    const playlistMatch = url.pathname.match(/playlist\/(\d+)/);
    if (playlistMatch) return playlistMatch[1];
    const id = url.searchParams.get("id");
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export {
  convertQqSongToMusicTrack,
  buildQqPlaylistApiPath,
  parseQqPlaylistResponse,
};

function getAbortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

async function fetchWithDeadline<T>(
  path: string,
  read: (response: Response) => Promise<T> | T,
  options: RequestInit = {},
  timeout = NETWORK_TIMEOUT
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = options.signal;
  let rejectOnAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = reject;
  });
  const rejectAbortedOperation = () =>
    rejectOnAbort(getAbortReason(controller.signal));
  controller.signal.addEventListener("abort", rejectAbortedOperation, {
    once: true,
  });

  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  const timer = window.setTimeout(() => controller.abort(), timeout);
  const operation = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) {
        throw getAbortReason(controller.signal);
      }
      return fetch(`${getApiUrl()}${QQ_PROXY_PREFIX}${path}`, {
        ...options,
        signal: controller.signal,
      });
    })
    .then(read);

  try {
    return await Promise.race([operation, aborted]);
  } finally {
    window.clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
    controller.signal.removeEventListener("abort", rejectAbortedOperation);
  }
}

async function postProxy<T>(
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T | null> {
  return fetchWithDeadline(
    "/proxy",
    async (response) => (response.ok ? ((await response.json()) as T) : null),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }
  );
}

export async function getQqPlaylistDetail(
  playlistId: string
): Promise<QqPlaylistDetail> {
  return fetchWithDeadline(
    "/playlist",
    async (response) => {
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error || `API error: ${response.status}`);
      }
      return (await response.json()) as QqPlaylistDetail;
    },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistId }),
    }
  );
}

export async function searchQqMusic(
  query: string,
  page: number,
  signal?: AbortSignal
): Promise<SearchPageResult<MusicTrack>> {
  return fetchWithDeadline(
    "/proxy",
    async (response) =>
      response.ok
        ? ((await response.json()) as SearchPageResult<MusicTrack>)
        : { items: [], hasMore: false },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "search", query, page }),
      signal,
    }
  );
}

export async function getQqMusicUrl(
  songmid: string,
  br?: number
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(songmid)) return null;
  const quality =
    typeof br === "number" && Number.isFinite(br) && br < 320 ? "128k" : "320k";
  return `/music-api/qqmusic/audio?${new URLSearchParams({
    songmid,
    quality,
  }).toString()}`;
}

export async function getQqMusicLyric(
  songmid: string,
  signal?: AbortSignal
): Promise<SongLyric | null> {
  return postProxy<SongLyric>({ type: "lyric", songmid }, signal);
}
