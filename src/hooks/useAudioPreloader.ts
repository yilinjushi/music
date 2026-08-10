import { useEffect, useRef } from "react";
import { useMusicStore } from "@/store/music-store";
import { logger } from "@/lib/logger";
import { buildUrlCacheKey } from "@/store/url-cache-store";
import { isSameTrackIdentity } from "@/lib/utils/track-identity";

/** 预加载触发阈值：剩余秒数 */
const PRELOAD_THRESHOLD_SECONDS = 10;

/** 预加载节流间隔（毫秒） */
const PRELOAD_THROTTLE_MS = 1000;

/**
 * 音频预加载 hook
 * 监听 timeupdate 事件，在当前歌曲快结束时解析下一首的 URL 到会话内存缓存
 */
export function useAudioPreloader(
  audioRef: React.RefObject<HTMLAudioElement | null>
) {
  const requestIdRef = useRef(0);
  const lastCheckTimeRef = useRef(0);
  const preloadedKeyRef = useRef<string | null>(null);
  const preloadControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      // 节流检查
      const now = Date.now();
      if (now - lastCheckTimeRef.current < PRELOAD_THROTTLE_MS) return;
      lastCheckTimeRef.current = now;

      const state = useMusicStore.getState();
      const { isPlaying, isRepeat, queue, currentIndex, quality } = state;

      // 前置条件检查
      if (!isPlaying) return;
      if (!navigator.onLine) return;
      if (!queue.length) return;
      if (queue.length <= 1 && !isRepeat) return;

      const duration = audio.duration || 0;
      const currentTime = audio.currentTime || 0;
      const remaining = duration - currentTime;

      // 时间阈值检查
      if (duration <= 30 || remaining > PRELOAD_THRESHOLD_SECONDS) return;

      // 计算下一首索引
      const nextIndex = (currentIndex + 1) % queue.length;
      const nextTrack = queue[nextIndex];
      const currentTrack = queue[currentIndex];
      if (!nextTrack) return;
      if (!currentTrack) return;

      // 本地音源无需预加载
      if (nextTrack.source === "local") return;

      // 防止重复预加载同一首歌
      const preloadKey = buildUrlCacheKey(
        nextTrack.source,
        nextTrack.id,
        nextTrack.url_id,
        quality
      );
      if (preloadedKeyRef.current === preloadKey) return;

      // 递增 requestId 取消之前的预加载
      const requestId = ++requestIdRef.current;
      preloadControllerRef.current?.abort();
      const controller = new AbortController();
      preloadControllerRef.current = controller;

      const stillOwnsPreload = () => {
        if (controller.signal.aborted || requestId !== requestIdRef.current) {
          return false;
        }
        const latest = useMusicStore.getState();
        const latestCurrent = latest.queue[latest.currentIndex];
        const latestNext =
          latest.queue[(latest.currentIndex + 1) % latest.queue.length];
        return (
          latest.quality === quality &&
          latest.currentIndex === currentIndex &&
          isSameTrackIdentity(latestCurrent, currentTrack) &&
          isSameTrackIdentity(latestNext, nextTrack)
        );
      };

      // 异步预加载
      void (async () => {
        try {
          const qualityNum = parseInt(quality, 10) || 192;
          const { resolveTrackUrl } = await import("@/lib/audio-resolver");
          if (!stillOwnsPreload()) return;
          const { url } = await resolveTrackUrl(
            nextTrack,
            qualityNum,
            controller.signal
          );

          // 检查是否被取消
          if (!stillOwnsPreload()) return;

          if (!url) return;

          // URL resolution already warms the session-memory cache.
          // Fetching a cross-origin audio response with no-cors can download
          // the entire recording while producing an opaque response that the
          // media element/SW cannot reliably reuse, so do not prefetch bytes.
          preloadedKeyRef.current = preloadKey;

          logger.info("useAudioPreloader", "Preload success", {
            trackId: nextTrack.id,
            source: nextTrack.source,
          });
        } catch (err) {
          // 静默失败，不影响主播放流程
          if (
            requestId === requestIdRef.current &&
            !controller.signal.aborted
          ) {
            logger.warn("useAudioPreloader", "Preload failed", {
              trackId: nextTrack.id,
              source: nextTrack.source,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      })();
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      preloadControllerRef.current?.abort();
    };
  }, [audioRef]);

  // 队列变更时重置预加载状态
  useEffect(() => {
    const unsubscribe = useMusicStore.subscribe((state, prevState) => {
      if (
        state.queue !== prevState.queue ||
        state.currentIndex !== prevState.currentIndex ||
        state.quality !== prevState.quality
      ) {
        preloadedKeyRef.current = null;
        requestIdRef.current++;
        preloadControllerRef.current?.abort();
        preloadControllerRef.current = null;
      }
    });
    return unsubscribe;
  }, []);
}
