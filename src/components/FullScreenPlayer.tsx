"use client";

import { createPortal } from "react-dom";
import { memo, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LyricsPanel } from "./LyricsPanel";
import { MusicCover } from "./MusicCover";
import { PlayerProgressBar } from "./PlayerProgressBar";
import { MusicTrack } from "@/types/music";
import {
  ChevronDown,
  Heart,
  ListVideo,
  Shuffle,
  Repeat,
  Repeat1,
  SkipBack,
  SkipForward,
  Play,
  Pause,
  SquareArrowOutUpRight,
  ClockFading,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useMounted } from "@/hooks/use-mounted";
import { usePlayerActions } from "@/hooks/usePlayerActions";
import { usePlayerUIState } from "@/hooks/usePlayerUIState";
import { PlayerQueueDrawer } from "./PlayerQueueDrawer";
import { MusicTrackMobileMenu } from "./MusicTrackMobileMenu";
import { AddToPlaylistDrawer } from "./AddToPlaylistDrawer";
import { QualityDrawer } from "./settings/QualityDrawer";
import { PlaybackSpeedDrawer } from "./settings/PlaybackSpeedDrawer";
import { SleepTimerDrawer } from "./settings/SleepTimerDrawer";
import { downloadMusicTrack } from "@/lib/utils/download";
import { getQualityShortLabel } from "@/lib/utils/quality";
import { formatTime } from "@/lib/utils/time";
import {
  useMusicStore,
  type FullScreenBackgroundMode,
} from "@/store/music-store";
import { useShallow } from "zustand/react/shallow";
import toast from "react-hot-toast";
import { useCoverColors } from "@/hooks/useCoverColors";
import { pickBestColor, createBackgroundColor } from "@/lib/utils/color";

interface ModeIconProps {
  isRepeat: boolean;
  isShuffle: boolean;
}

function ModeIcon({ isRepeat, isShuffle }: ModeIconProps) {
  if (isRepeat) return <Repeat1 className="size-7" />;
  if (isShuffle) return <Shuffle className="size-7" />;
  return <Repeat className="size-7" />;
}

const BackgroundLayer = memo(
  ({
    hslColor,
    coverUrl,
    mode,
  }: {
    hslColor: [number, number, number] | null;
    coverUrl: string | null;
    mode: FullScreenBackgroundMode;
  }) => {
    const showThemeColor = mode === "theme" && hslColor;
    const showCoverMask = mode === "cover" && coverUrl;
    const dynamicStyle = useMemo(() => {
      if (!showThemeColor) return undefined;
      const [h, s, l] = hslColor;
      return {
        "--bg-h": h,
        "--bg-s": `${s}%`,
        "--bg-l": `${l}%`,
        // Flat colour field, no gradient: modernist poster look.
        background: "hsl(var(--bg-h), var(--bg-s), calc(var(--bg-l) - 8%))",
      } as React.CSSProperties;
    }, [hslColor, showThemeColor]);

    return (
      <div className="absolute inset-0 z-[-1] overflow-hidden bg-zinc-950">
        {/* 动态颜色层 */}
        <div
          className={cn(
            "absolute inset-0 transition-opacity duration-1000 ease-in-out",
            showThemeColor ? "opacity-100" : "opacity-0"
          )}
          style={dynamicStyle}
        />

        {/* 封面遮罩层 */}
        <div
          className={cn(
            "absolute inset-0 transition-opacity duration-1000",
            showCoverMask ? "opacity-100" : "opacity-0"
          )}
        >
          {/* Solid layer instead of a blurred cover: blur-3xl kept the GPU busy. */}
          <div className="absolute inset-0 bg-black/90" />
        </div>

        {/* 兜底背景层 */}
        <div
          className={cn(
            "absolute inset-0 transition-opacity duration-1000",
            showThemeColor || showCoverMask ? "opacity-0" : "opacity-100"
          )}
        >
          <div className="absolute inset-0 bg-black" />
          <div className="absolute left-0 top-0 h-full w-2 bg-primary" />
        </div>
      </div>
    );
  }
);
BackgroundLayer.displayName = "BackgroundLayer";

interface FullScreenPlayerProps {
  isFullScreen: boolean;
  onClose: () => void;
}

export function FullScreenPlayer({
  isFullScreen,
  onClose,
}: FullScreenPlayerProps) {
  const isMounted = useMounted();
  const {
    showLyrics,
    setShowLyrics,
    moreDrawerOpen,
    setMoreDrawerOpen,
    isAddToPlaylistOpen,
    setIsAddToPlaylistOpen,
    qualityDrawerOpen,
    setQualityDrawerOpen,
    speedDrawerOpen,
    setSpeedDrawerOpen,
    sleepDrawerOpen,
    setSleepDrawerOpen,
  } = usePlayerUIState(isFullScreen);

  const {
    queue,
    quality,
    currentIndex,
    setCurrentIndexAndPlay,
    clearQueue,
    reshuffle,
    removeFromQueue,
    playTrackAsNext,
    fullScreenBackgroundMode,
    playbackSpeed,
    sleepTimerIsActive,
    sleepTimerRemaining,
    isPlaying,
    isLoading,
    isRepeat,
    isShuffle,
    togglePlay,
    toggleRepeat,
    toggleShuffle,
    coverUrl,
  } = useMusicStore(
    useShallow((state) => ({
      queue: state.queue,
      currentIndex: state.currentIndex,
      setCurrentIndexAndPlay: state.setCurrentIndexAndPlay,
      clearQueue: state.clearQueue,
      reshuffle: state.reshuffle,
      removeFromQueue: state.removeFromQueue,
      playTrackAsNext: state.playTrackAsNext,
      quality: state.quality,
      fullScreenBackgroundMode: state.fullScreenBackgroundMode,
      playbackSpeed: state.playbackSpeed,
      sleepTimerIsActive: state.sleepTimerIsActive,
      sleepTimerRemaining: state.sleepTimerRemaining,
      isPlaying: state.isPlaying,
      isLoading: state.isLoading,
      isRepeat: state.isRepeat,
      isShuffle: state.isShuffle,
      togglePlay: state.togglePlay,
      toggleRepeat: state.toggleRepeat,
      toggleShuffle: state.toggleShuffle,
      coverUrl: state.coverUrl,
    }))
  );

  const currentTrack = queue[currentIndex] || null;

  const {
    handleShare,
    handleToggleLike,
    copyTrackInfo,
    isCurrentTrackFavorite,
    trackInfoPressHandlers,
  } = usePlayerActions(currentTrack);

  const { swatches } = useCoverColors(
    coverUrl && fullScreenBackgroundMode === "theme" ? coverUrl : null
  );

  const hslColor = useMemo(() => {
    if (!swatches) return null;
    const dominant = pickBestColor(swatches);
    return dominant ? createBackgroundColor(dominant) : null;
  }, [swatches]);

  const playTrack = (index: number) => setCurrentIndexAndPlay(index);

  const handleClearQueue = () => {
    if (confirm("确定要清空播放列表吗？")) {
      clearQueue();
      toast.success("播放列表已清空");
    }
  };

  const handleRemoveFromQueue = (track: MusicTrack) => {
    removeFromQueue(track);
  };

  if (!isMounted) return null;

  // 循环切换播放模式：none → repeat → shuffle → none
  const handleModeToggle = () => {
    if (!isShuffle && !isRepeat) toggleRepeat();
    else if (isRepeat) {
      toggleRepeat();
      toggleShuffle();
    } else toggleShuffle();
  };

  const handlePrev = () => {
    if (queue.length === 0) return;
    setCurrentIndexAndPlay((currentIndex - 1 + queue.length) % queue.length);
  };

  const handleNext = () => {
    if (queue.length === 0) return;
    setCurrentIndexAndPlay((currentIndex + 1) % queue.length);
  };

  return createPortal(
    <div
      role="dialog"
      aria-label="全屏播放器"
      aria-modal={isFullScreen || undefined}
      aria-hidden={!isFullScreen}
      inert={!isFullScreen}
      className={cn(
        "fixed inset-0 z-50 transition-transform duration-500 ease-in-out flex flex-col",
        isFullScreen ? "translate-y-0" : "translate-y-full"
      )}
    >
      {/* 背景渲染层 */}
      <BackgroundLayer
        hslColor={hslColor}
        coverUrl={coverUrl}
        mode={fullScreenBackgroundMode}
      />

      <header className="shrink-0 flex items-center justify-between px-6 pt-[calc(1rem+var(--safe-area-top))] pb-6 relative z-10">
        <Button
          variant="ghost"
          size="icon"
          className="h-16 w-16 text-white/60 hover:bg-white/10 hover:text-white"
          onClick={() => {
            onClose();
          }}
          aria-label="收起全屏播放器"
        >
          <ChevronDown className="size-8" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs tracking-widest text-white/60 hover:text-white hover:bg-white/10 h-12 px-4"
          onClick={() => setQualityDrawerOpen(true)}
          aria-label={`选择播放音质，当前 ${getQualityShortLabel(quality)}`}
        >
          {!showLyrics && getQualityShortLabel(quality)}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-16 w-16 text-white/60 hover:bg-white/10 hover:text-white"
          onClick={handleShare}
          aria-label="分享当前歌曲"
        >
          <SquareArrowOutUpRight className="size-7" />
        </Button>
      </header>

      <div
        className="flex-1 flex flex-col items-center justify-center px-2 relative z-10 overflow-hidden cursor-pointer"
        onClick={() => {
          setShowLyrics(!showLyrics);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setShowLyrics((visible) => !visible);
          }
        }}
        role="button"
        tabIndex={0}
        aria-pressed={showLyrics}
        aria-label={showLyrics ? "显示专辑封面" : "显示歌词"}
      >
        {showLyrics ? (
          <div className="w-full h-full">
            <LyricsPanel track={currentTrack} active={isFullScreen} />
          </div>
        ) : (
          <div
            className={cn(
              "relative aspect-square w-72 max-w-[320px] overflow-hidden rounded-3xl transition-transform duration-500 ring-1 ring-white/5",
              isPlaying ? "scale-100" : "scale-[0.95]"
            )}
          >
            <MusicCover
              src={coverUrl}
              alt={currentTrack?.name}
              className="h-full w-full object-cover dark select-none touch-none"
              iconClassName="h-16 w-16 text-white/30"
            />
          </div>
        )}
      </div>

      <div className="shrink-0 px-8 py-4 relative z-10">
        <div className="flex items-center justify-between">
          <div
            className={cn("min-w-0 flex-1 cursor-pointer select-none")}
            onMouseDown={trackInfoPressHandlers.onMouseDown}
            onMouseUp={trackInfoPressHandlers.onMouseUp}
            onMouseLeave={trackInfoPressHandlers.onMouseLeave}
            onTouchStart={trackInfoPressHandlers.onTouchStart}
            onTouchEnd={trackInfoPressHandlers.onTouchEnd}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void copyTrackInfo();
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="复制当前歌曲信息"
            title="长按复制歌曲信息"
          >
            <h2 className="truncate text-xl font-semibold text-white">
              {currentTrack?.name || "未知歌曲"}
            </h2>
            <p className="truncate text-sm text-white/60 mt-1">
              {currentTrack?.artist?.join(", ") || "未知歌手"}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-14 w-14 text-white/70 hover:bg-white/10 hover:text-white"
              onClick={(e) => {
                e.stopPropagation();
                handleToggleLike();
              }}
              aria-label={
                isCurrentTrackFavorite ? "取消喜欢当前歌曲" : "喜欢当前歌曲"
              }
            >
              <Heart
                className={cn(
                  "size-8 transition-all",
                  isCurrentTrackFavorite && "fill-primary text-primary"
                )}
              />
            </Button>
            {currentTrack && (
              <>
                <MusicTrackMobileMenu
                  track={currentTrack}
                  open={moreDrawerOpen}
                  onOpenChange={setMoreDrawerOpen}
                  onAddToPlaylist={() => {
                    setIsAddToPlaylistOpen(true);
                  }}
                  onDownload={() => {
                    downloadMusicTrack(currentTrack, parseInt(quality));
                  }}
                  isFavorite={isCurrentTrackFavorite}
                  onToggleLike={() => {
                    handleToggleLike();
                  }}
                  triggerClassName="h-14 w-14 text-white/70 hover:bg-white/10 hover:text-white [&_svg]:size-8!"
                  onNavigate={() => {
                    onClose();
                  }}
                />
                <AddToPlaylistDrawer
                  open={isAddToPlaylistOpen}
                  onOpenChange={setIsAddToPlaylistOpen}
                  track={currentTrack}
                />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0 px-8 relative z-10">
        <PlayerProgressBar
          className="relative"
          leftTimeSuffix={
            playbackSpeed !== 1.0 ? (
              <span className="ml-1 text-[0.7em] align-sub opacity-70">
                x{playbackSpeed.toFixed(1)}
              </span>
            ) : null
          }
          centerContent={
            sleepTimerIsActive ? (
              <span className="flex items-center gap-1 text-[0.85em]">
                <ClockFading className="w-2.5 h-2.5" />
                {formatTime(sleepTimerRemaining)}
              </span>
            ) : null
          }
          onLeftTimeClick={() => setSpeedDrawerOpen(true)}
          onRightTimeClick={() => setSleepDrawerOpen(true)}
          onCenterClick={() => setSleepDrawerOpen(true)}
        />
      </div>

      <div className="shrink-0 flex items-center justify-between px-4 py-6 pb-[calc(2rem+var(--safe-area-bottom))] relative z-10">
        <Button
          variant="ghost"
          size="icon"
          className="h-16 w-16 transition-colors text-white/70 hover:text-white hover:bg-white/10"
          onClick={handleModeToggle}
          aria-label={
            isRepeat
              ? "切换播放模式，当前单曲循环"
              : isShuffle
                ? "切换播放模式，当前随机播放"
                : "切换播放模式，当前顺序播放"
          }
        >
          <ModeIcon isRepeat={isRepeat} isShuffle={isShuffle} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-16 w-16 text-white/70 hover:bg-white/10 hover:text-white"
          onClick={handlePrev}
          aria-label="上一首"
        >
          <SkipBack className="size-9 fill-current" />
        </Button>
        <Button
          size="icon"
          className="h-20 w-20 bg-transparent text-white/70 shadow-none hover:bg-white/10 hover:text-white active:scale-95 transition-all"
          onClick={togglePlay}
          disabled={isLoading}
          aria-label={isLoading ? "正在加载" : isPlaying ? "暂停" : "播放"}
        >
          {isLoading ? (
            <Spinner className="size-10 text-white/70" />
          ) : isPlaying ? (
            <Pause className="size-10 fill-current" />
          ) : (
            <Play className="size-10 fill-current ml-1" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-16 w-16 text-white/70 hover:bg-white/10 hover:text-white"
          onClick={handleNext}
          aria-label="下一首"
        >
          <SkipForward className="size-9 fill-current" />
        </Button>
        <PlayerQueueDrawer
          queue={queue}
          currentIndex={currentIndex}
          isPlaying={isPlaying}
          isShuffle={isShuffle}
          onPlay={playTrack}
          onClear={handleClearQueue}
          onReshuffle={reshuffle}
          onRemove={handleRemoveFromQueue}
          onPlayTrack={playTrackAsNext}
          trigger={
            <Button
              variant="ghost"
              size="icon"
              className="h-16 w-16 text-white/70 hover:bg-white/10 hover:text-white"
              aria-label="播放列表"
            >
              <ListVideo className="size-7" />
            </Button>
          }
        />
      </div>

      <QualityDrawer
        open={qualityDrawerOpen}
        onOpenChange={setQualityDrawerOpen}
      />
      <PlaybackSpeedDrawer
        open={speedDrawerOpen}
        onOpenChange={setSpeedDrawerOpen}
      />
      <SleepTimerDrawer
        open={sleepDrawerOpen}
        onOpenChange={setSleepDrawerOpen}
      />
    </div>,
    document.body
  );
}
