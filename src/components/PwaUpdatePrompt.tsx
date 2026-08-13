import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import toast from "react-hot-toast";
import { useRegisterSW } from "virtual:pwa-register/react";
import { useMusicStore } from "@/store/music-store";

export function PwaUpdatePrompt() {
  const isPlaying = useMusicStore((state) => state.isPlaying);
  const [mediaIsPlaying, setMediaIsPlaying] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    if (!offlineReady) return;
    toast.success("播放器已可离线打开");
    setOfflineReady(false);
  }, [offlineReady, setOfflineReady]);

  useEffect(() => {
    const audio = document.querySelector("audio");
    if (!audio) {
      setMediaIsPlaying(false);
      return;
    }

    const syncPlaybackState = () => {
      setMediaIsPlaying(!audio.paused && !audio.ended);
    };
    syncPlaybackState();
    audio.addEventListener("play", syncPlaybackState);
    audio.addEventListener("playing", syncPlaybackState);
    audio.addEventListener("pause", syncPlaybackState);
    audio.addEventListener("ended", syncPlaybackState);

    return () => {
      audio.removeEventListener("play", syncPlaybackState);
      audio.removeEventListener("playing", syncPlaybackState);
      audio.removeEventListener("pause", syncPlaybackState);
      audio.removeEventListener("ended", syncPlaybackState);
    };
  }, [needRefresh]);

  if (!needRefresh) return null;

  const playbackActive = isPlaying || mediaIsPlaying;

  const applyUpdate = async () => {
    const audio = document.querySelector("audio");
    if (isApplying || isPlaying || (audio && !audio.paused && !audio.ended))
      return;

    setIsApplying(true);
    try {
      const registration = await navigator.serviceWorker?.getRegistration(
        new URL("/", window.location.href)
      );
      if (registration?.waiting) {
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => window.location.reload(),
          { once: true }
        );
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
        return;
      }
      await updateServiceWorker(true);
    } catch {
      setIsApplying(false);
      toast.error("更新失败，请稍后重试");
    }
  };

  return (
    <section
      aria-live="polite"
      aria-label="播放器更新"
      className="pointer-events-auto fixed inset-x-3 bottom-[calc(var(--safe-area-bottom)+12px)] z-[100] mx-auto max-w-md rounded-2xl border bg-background/95 p-3 shadow-xl backdrop-blur"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">新版本已准备好</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {playbackActive
              ? "请先暂停音乐，再刷新到新版本"
              : "由你决定何时刷新，不会自动打断播放"}
          </p>
        </div>
        <button
          type="button"
          className="pointer-events-auto touch-target inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={playbackActive || isApplying}
          onClick={() => void applyUpdate()}
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          更新
        </button>
        <button
          type="button"
          aria-label="稍后更新"
          className="pointer-events-auto touch-target inline-flex items-center justify-center rounded-xl text-muted-foreground hover:bg-muted"
          onClick={() => setNeedRefresh(false)}
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>
    </section>
  );
}
