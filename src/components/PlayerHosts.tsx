import { lazy, Suspense, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useExitLayer } from "@/hooks/useExitLayer";
import { useMusicStore } from "@/store/music-store";

const MusicNowPlayingBar = lazy(() =>
  import("@/components/MusicNowPlayingBar").then((module) => ({
    default: module.MusicNowPlayingBar,
  }))
);

const FullScreenPlayer = lazy(() =>
  import("@/components/FullScreenPlayer").then((module) => ({
    default: module.FullScreenPlayer,
  }))
);

export function PlayerBarHost({ isTab }: { isTab: boolean }) {
  const { hasCurrentTrack, isFullScreenPlayer, setIsFullScreenPlayer } =
    useMusicStore(
      useShallow((state) => ({
        hasCurrentTrack: state.queue.length > 0 && state.currentIndex >= 0,
        isFullScreenPlayer: state.isFullScreenPlayer,
        setIsFullScreenPlayer: state.setIsFullScreenPlayer,
      }))
    );

  if (!hasCurrentTrack || isFullScreenPlayer) return null;

  return (
    <Suspense fallback={null}>
      <MusicNowPlayingBar
        onOpenFullScreen={() => setIsFullScreenPlayer(true)}
        isTab={isTab}
      />
    </Suspense>
  );
}

export function PlayerRuntimeHost() {
  const { isFullScreenPlayer, setIsFullScreenPlayer } = useMusicStore(
    useShallow((state) => ({
      isFullScreenPlayer: state.isFullScreenPlayer,
      setIsFullScreenPlayer: state.setIsFullScreenPlayer,
    }))
  );
  const [hasOpenedFullScreen, setHasOpenedFullScreen] =
    useState(isFullScreenPlayer);
  const { push, pop } = useExitLayer();

  useEffect(() => {
    if (isFullScreenPlayer) setHasOpenedFullScreen(true);
  }, [isFullScreenPlayer]);

  useEffect(() => {
    if (!isFullScreenPlayer) return;
    const id = push({ close: () => setIsFullScreenPlayer(false) });
    return () => pop(id);
  }, [isFullScreenPlayer, setIsFullScreenPlayer, push, pop]);

  return (
    <>
      {hasOpenedFullScreen && (
        <Suspense fallback={null}>
          <FullScreenPlayer
            isFullScreen={isFullScreenPlayer}
            onClose={() => setIsFullScreenPlayer(false)}
          />
        </Suspense>
      )}
    </>
  );
}
