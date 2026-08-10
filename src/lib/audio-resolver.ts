import { musicApi } from "@/lib/music-api";
import { normalizeAudioUrlForPlayback } from "@/lib/utils/audio-url";
import { useUrlCacheStore, buildUrlCacheKey } from "@/store/url-cache-store";
import type { MusicTrack } from "@/types/music";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error("AUDIO_RESOLUTION_ABORTED"), {
      name: "AbortError",
    });
  }
}

function waitBeforeRetry(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        Object.assign(new Error("AUDIO_RESOLUTION_ABORTED"), {
          name: "AbortError",
        })
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 800);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 获取远程音频 URL 并带有重试机制
 */
async function resolveRemoteAudioUrl(
  track: MusicTrack,
  quality: number,
  signal?: AbortSignal
): Promise<string> {
  const maxRetries = navigator.onLine ? 2 : 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    throwIfAborted(signal);
    try {
      const url = await musicApi.getUrl(track, quality, signal);
      throwIfAborted(signal);
      if (!url) throw new Error("EMPTY_URL");
      return url;
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal);
      lastError = error;
      if (attempt < maxRetries) {
        await waitBeforeRetry(signal);
        throwIfAborted(signal);
      }
    }
  }

  throw lastError;
}

/**
 * 解析曲目的最佳播放 URL
 * 优先级：内存 URL → 远端请求
 *
 * 供 useAudioTrackLoader（主播放）和 useAudioPreloader（预加载）共享使用
 */
export async function resolveTrackUrl(
  track: MusicTrack,
  quality: number,
  signal?: AbortSignal
): Promise<{ url: string }> {
  throwIfAborted(signal);
  const { id: trackId, source, url_id: urlId } = track;
  const trackKey = buildUrlCacheKey(source, trackId, urlId, String(quality));

  // 内存缓存
  const cacheStore = useUrlCacheStore.getState();
  const memCached = cacheStore.get(trackKey);
  if (memCached) {
    return { url: normalizeAudioUrlForPlayback(memCached) };
  }
  const cacheWriteGeneration = cacheStore.generation;

  // 离线无资源
  if (!navigator.onLine) return { url: "" };

  // 远端请求
  const remoteUrl = await resolveRemoteAudioUrl(track, quality, signal);
  throwIfAborted(signal);
  // Provider responses are untrusted and may contain an obsolete /proxy URL
  // or an HTTP endpoint. Normalize once before either exposing the URL to the
  // player or retaining it in the session cache so both consumers see the
  // exact same, revalidated value.
  const playableUrl = normalizeAudioUrlForPlayback(remoteUrl);
  throwIfAborted(signal);
  cacheStore.setIfCurrentGeneration(
    trackKey,
    playableUrl,
    cacheWriteGeneration
  );
  return { url: playableUrl };
}

/**
 * Invalidate every layer that can retain a resolved media URL. This must
 * complete before a recovery request resolves the track again.
 */
export async function invalidateTrackUrlCache(
  track: MusicTrack,
  quality: number,
  signal?: AbortSignal
): Promise<void> {
  const { id: trackId, source, url_id: urlId } = track;
  const trackKey = buildUrlCacheKey(source, trackId, urlId, String(quality));

  if (signal?.aborted) return;
  useUrlCacheStore.getState().delete(trackKey);
  if (signal?.aborted) return;
  await musicApi.deleteUrlCache(track, quality, signal);
}
