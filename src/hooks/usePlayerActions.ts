import { useRef, useCallback } from "react";
import { useMusicStore } from "@/store/music-store";
import { buildCanonicalTrackShareText } from "@/lib/share-url";
import { writeClipboardText } from "@/lib/clipboard";
import { toastUtils } from "@/lib/utils/toast";
import type { MusicTrack } from "@/types/music";
import { isSameTrackIdentity } from "@/lib/utils/track-identity";
import toast from "react-hot-toast";

export function usePlayerActions(currentTrack: MusicTrack | null) {
  const pressTimerRef = useRef<NodeJS.Timeout | null>(null);

  const favorites = useMusicStore((s) => s.favorites);
  const isFavorite = useMusicStore((s) => s.isFavorite);
  const addToFavorites = useMusicStore((s) => s.addToFavorites);
  const removeFromFavorites = useMusicStore((s) => s.removeFromFavorites);

  const isCurrentTrackFavorite = currentTrack
    ? favorites.some(
        (track) => isSameTrackIdentity(track, currentTrack) && !track.is_deleted
      )
    : false;

  const handleShare = useCallback(async () => {
    if (!currentTrack) return toast.error("暂无歌曲信息");

    // Resolved media URLs may be short-lived bearer capabilities. Only an
    // explicitly canonical, public page URL is ever shareable.
    const shareText = buildCanonicalTrackShareText(currentTrack);
    if (!shareText) return toast.error("该音源暂不支持分享");

    const ok = await writeClipboardText(shareText);
    if (ok) {
      toast.success("已复制到剪贴板");
    } else {
      toast.error("复制失败，请重试");
    }
  }, [currentTrack]);

  const handleToggleLike = useCallback(() => {
    if (!currentTrack) return;
    if (isFavorite(currentTrack)) {
      removeFromFavorites(currentTrack);
      toast.success("已取消喜欢");
    } else {
      const error = addToFavorites(currentTrack);
      if (error) {
        toastUtils.info(error);
      } else {
        toast.success("已喜欢");
      }
    }
  }, [currentTrack, isFavorite, addToFavorites, removeFromFavorites]);

  const copyTrackInfo = useCallback(async () => {
    if (!currentTrack) return;

    const text = `${currentTrack.name} - ${currentTrack.artist.join(", ")}`;
    const ok = await writeClipboardText(text);
    if (ok) {
      toast.success("已复制歌曲信息");
    } else {
      toast.error("复制失败，请重试");
    }
  }, [currentTrack]);

  const handleTrackInfoPressStart = useCallback(() => {
    if (!currentTrack) return;

    pressTimerRef.current = setTimeout(() => {
      void copyTrackInfo();
    }, 500);
  }, [copyTrackInfo, currentTrack]);

  const handleTrackInfoPressEnd = useCallback(() => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);

  return {
    handleShare,
    handleToggleLike,
    copyTrackInfo,
    isCurrentTrackFavorite,
    trackInfoPressHandlers: {
      onMouseDown: handleTrackInfoPressStart,
      onMouseUp: handleTrackInfoPressEnd,
      onMouseLeave: handleTrackInfoPressEnd,
      onTouchStart: handleTrackInfoPressStart,
      onTouchEnd: handleTrackInfoPressEnd,
    },
  };
}
