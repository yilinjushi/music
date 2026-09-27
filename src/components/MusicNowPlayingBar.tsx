"use client";

import { ListVideo, Pause, Play } from "lucide-react";
import { useMusicStore } from "@/store/music-store";
import { useShallow } from "zustand/react/shallow";
import { PlayerQueueDrawer } from "./PlayerQueueDrawer";
import { MusicCover } from "./MusicCover";
import { useCallback } from "react";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import type { MusicTrack } from "@/types/music";

interface MusicNowPlayingBarProps {
  onOpenFullScreen?: () => void;
  isTab?: boolean;
}

export function MusicNowPlayingBar({
  onOpenFullScreen,
  isTab = true,
}: MusicNowPlayingBarProps) {
  const {
    isPlaying,
    currentAudioTime,
    duration,
    isShuffle,
    queue,
    currentIndex,
    coverUrl,
    togglePlay,
    setCurrentIndexAndPlay,
    clearQueue,
    reshuffle,
    removeFromQueue,
    playTrackAsNext,
  } = useMusicStore(
    useShallow((state) => ({
      isPlaying: state.isPlaying,
      currentAudioTime: state.currentAudioTime,
      duration: state.duration,
      isShuffle: state.isShuffle,
      queue: state.queue,
      currentIndex: state.currentIndex,
      coverUrl: state.coverUrl,
      togglePlay: state.togglePlay,
      setCurrentIndexAndPlay: state.setCurrentIndexAndPlay,
      clearQueue: state.clearQueue,
      reshuffle: state.reshuffle,
      removeFromQueue: state.removeFromQueue,
      playTrackAsNext: state.playTrackAsNext,
    }))
  );

  const currentTrack = queue[currentIndex] || null;

  const playTrack = useCallback(
    (index: number) => {
      setCurrentIndexAndPlay(index);
    },
    [setCurrentIndexAndPlay]
  );

  const handleClearQueue = () => {
    if (confirm("确定要清空播放列表吗？")) {
      clearQueue();
      toast.success("播放列表已清空");
    }
  };

  const handleRemoveFromQueue = useCallback(
    (track: MusicTrack) => {
      removeFromQueue(track);
    },
    [removeFromQueue]
  );

  const progress = duration > 0 ? (currentAudioTime / duration) * 100 : 0;
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress / 100);

  if (!currentTrack) {
    return null; // 使用 null 替代 undefined 更符合 React 规范
  }

  return (
    <div className="w-full">
      <div
        className={cn(
          "flex items-center transition-all duration-300",
          isTab
            ? "gap-2 px-3 py-1.5 bg-card border-t-2 border-primary"
            : "gap-3 px-4 py-2.5 bg-card border-t-2 border-primary pb-[calc(0.75rem+var(--safe-area-bottom))]"
        )}
      >
        {/* 不含列表按钮，避免遮罩层关闭时 ghost click 误触发全屏 */}
        <button
          type="button"
          className="flex min-h-11 flex-1 min-w-0 items-center text-left"
          onClick={() => onOpenFullScreen?.()}
          aria-label={`打开正在播放：${currentTrack.name}`}
        >
          {/* 专辑封面 */}
          <div
            className={cn(
              "relative shrink-0 overflow-hidden rounded-md transition-all duration-300 shadow-sm",
              isTab ? "h-8 w-8" : "h-11 w-11"
            )}
          >
            <MusicCover
              src={coverUrl}
              alt={currentTrack.name}
              className="w-full h-full"
              iconClassName={isTab ? "h-4 w-4" : "h-5 w-5"}
            />
          </div>

          {/* 歌曲信息 - 单行 */}
          <p className="flex-1 min-w-0 truncate flex items-baseline gap-1.5 ml-2">
            <span
              className={cn(
                "font-medium text-foreground transition-all duration-300",
                isTab ? "text-sm" : "text-base"
              )}
            >
              {currentTrack.name}
            </span>
            <span
              className={cn(
                "text-muted-foreground truncate transition-all duration-300",
                isTab ? "text-xs" : "text-sm"
              )}
            >
              - {currentTrack.artist?.join(", ")}
            </span>
          </p>
        </button>

        {/* 圆环播放按钮 */}
        <div className="relative h-11 w-11 min-h-11 min-w-11 shrink-0 transition-all duration-300">
          {/* SVG 圆环进度 (利用 viewBox 自动等比缩放) */}
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 40 40">
            {/* 背景圆环 */}
            <circle
              cx="20"
              cy="20"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={isTab ? "2" : "2.5"}
              className="text-muted/30 transition-all duration-300"
            />
            {/* 进度圆环 - 从上方开始 */}
            <circle
              cx="20"
              cy="20"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={isTab ? "2" : "2.5"}
              strokeLinecap="round"
              className="text-primary transition-[stroke-dashoffset] duration-300"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              transform="rotate(-90 20 20)"
            />
          </svg>

          {/* 播放按钮 */}
          <button
            type="button"
            className="absolute inset-0 flex items-center justify-center text-primary hover:text-primary/80 transition-colors focus:outline-none"
            onClick={togglePlay}
            aria-label={isPlaying ? "暂停" : "播放"}
          >
            {isPlaying ? (
              <Pause
                className={cn(
                  "fill-current transition-all duration-300",
                  isTab ? "h-4 w-4" : "h-5 w-5"
                )}
              />
            ) : (
              <Play
                className={cn(
                  "ml-0.5 fill-current transition-all duration-300",
                  isTab ? "h-4 w-4" : "h-5 w-5"
                )}
              />
            )}
          </button>
        </div>

        {/* 与可点击区域为兄弟节点，ghost click 不会冒泡 */}
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
            <button
              type="button"
              className={cn(
                "touch-target inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-all shrink-0 focus:outline-none",
                isTab ? "p-1.5" : "p-2 ml-1"
              )}
              aria-label="播放列表"
            >
              <ListVideo
                className={cn(
                  "transition-all duration-300",
                  isTab ? "h-4 w-4" : "h-[22px] w-[22px]"
                )}
              />
            </button>
          }
        />
      </div>
    </div>
  );
}
