"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { formatMediaTime } from "@/lib/utils/music";
import { useMusicStore } from "@/store/music-store";
import { useShallow } from "zustand/react/shallow";

interface PlayerProgressBarProps {
  className?: string;
  leftTimeSuffix?: React.ReactNode;
  centerContent?: React.ReactNode;
  onLeftTimeClick?: () => void;
  onRightTimeClick?: () => void;
  onCenterClick?: () => void;
}

export function PlayerProgressBar({
  className,
  leftTimeSuffix,
  centerContent,
  onLeftTimeClick,
  onRightTimeClick,
  onCenterClick,
}: PlayerProgressBarProps) {
  const { currentTime, duration, seek } = useMusicStore(
    useShallow((state) => ({
      currentTime: state.currentAudioTime,
      duration: state.duration,
      seek: state.seek,
    }))
  );

  const barRef = React.useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [dragTime, setDragTime] = React.useState(0);
  const dragTimeRef = React.useRef(0);
  const activePointerIdRef = React.useRef<number | null>(null);

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const currentProgress = safeDuration ? (currentTime / safeDuration) * 100 : 0;
  const dragProgress = safeDuration ? (dragTime / safeDuration) * 100 : 0;
  const displayProgress = isDragging ? dragProgress : currentProgress;

  const getPercent = (clientX: number) => {
    if (!barRef.current) return 0;
    const { left, width } = barRef.current.getBoundingClientRect();
    return Math.min(Math.max((clientX - left) / width, 0), 1);
  };

  const handleStart = (clientX: number) => {
    if (safeDuration <= 0) return;
    setIsDragging(true);
    const p = getPercent(clientX);
    const time = p * safeDuration;
    setDragTime(time);
    dragTimeRef.current = time;
  };

  const handleMove = React.useCallback(
    (clientX: number) => {
      const p = getPercent(clientX);
      const time = p * safeDuration;
      setDragTime(time);
      dragTimeRef.current = time;
    },
    [safeDuration]
  );

  const handleEnd = React.useCallback(
    (commit: boolean) => {
      if (commit && safeDuration > 0) seek(dragTimeRef.current);
      setIsDragging(false);
    },
    [safeDuration, seek]
  );

  const finishPointer = (
    event: React.PointerEvent<HTMLDivElement>,
    commit: boolean
  ) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activePointerIdRef.current = null;
    handleEnd(commit);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      safeDuration <= 0 ||
      activePointerIdRef.current !== null ||
      event.isPrimary === false ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    activePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    handleStart(event.clientX);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    handleMove(event.clientX);
  };

  React.useEffect(() => {
    return () => {
      activePointerIdRef.current = null;
    };
  }, []);

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    finishPointer(event, true);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    finishPointer(event, false);
  };

  const handleLostPointerCapture = (
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    activePointerIdRef.current = null;
    handleEnd(false);
  };

  const handleSliderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!Number.isFinite(duration) || duration <= 0) return;
    let nextTime: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      nextTime = currentTime - 5;
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      nextTime = currentTime + 5;
    } else if (event.key === "Home") {
      nextTime = 0;
    } else if (event.key === "End") {
      nextTime = duration;
    }
    if (nextTime === null) return;
    event.preventDefault();
    seek(Math.min(Math.max(nextTime, 0), duration));
  };

  const handleActivationKey = (
    event: React.KeyboardEvent<HTMLElement>,
    handler?: () => void
  ) => {
    if (!handler || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    handler();
  };

  return (
    <div className={cn("w-full", className)}>
      <div
        ref={barRef}
        className="group relative z-10 flex min-h-11 w-full touch-none cursor-pointer select-none items-center py-3"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onKeyDown={handleSliderKeyDown}
        role="slider"
        tabIndex={0}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={safeDuration}
        aria-valuenow={
          Number.isFinite(currentTime)
            ? Math.min(Math.max(currentTime, 0), safeDuration)
            : 0
        }
        aria-valuetext={`${formatMediaTime(currentTime)} / ${formatMediaTime(duration)}`}
      >
        <div className="relative w-full h-1.5 group-hover:h-2 transition-all rounded-full bg-white/20">
          <div
            className={cn(
              "absolute inset-y-0 left-0 bg-white rounded-full flex items-center justify-end shadow-[0_0_10px_rgba(255,255,255,0.3)]",
              !isDragging && "transition-all"
            )}
            style={{ width: `${displayProgress}%` }}
          >
            {/* 拖拽/悬停时显示的小圆点指示器 */}
            <div
              className={cn(
                "w-3 h-3 bg-white rounded-full shadow-md translate-x-1.5 transition-opacity duration-200",
                isDragging
                  ? "opacity-100 scale-110"
                  : "opacity-0 group-hover:opacity-100"
              )}
            />
          </div>
        </div>
      </div>
      <div className="relative flex justify-between text-base text-white/70 font-medium mt-1.5 px-0.5 tracking-wider">
        <span
          className={cn(
            "flex min-h-11 min-w-11 items-center gap-0.5",
            onLeftTimeClick &&
              "cursor-pointer hover:text-white transition-colors"
          )}
          onClick={onLeftTimeClick}
          onKeyDown={(event) => handleActivationKey(event, onLeftTimeClick)}
          role={onLeftTimeClick ? "button" : undefined}
          tabIndex={onLeftTimeClick ? 0 : undefined}
          aria-label={onLeftTimeClick ? "切换已播放时间显示" : undefined}
        >
          {formatMediaTime(isDragging ? dragTime : currentTime)}
          {leftTimeSuffix}
        </span>
        {centerContent && (
          <span
            className={cn(
              "absolute left-1/2 inline-flex min-h-11 min-w-11 -translate-x-1/2 items-center justify-center",
              onCenterClick &&
                "cursor-pointer hover:text-white transition-colors"
            )}
            onClick={onCenterClick}
            onKeyDown={(event) => handleActivationKey(event, onCenterClick)}
            role={onCenterClick ? "button" : undefined}
            tabIndex={onCenterClick ? 0 : undefined}
            aria-label={onCenterClick ? "切换进度显示" : undefined}
          >
            {centerContent}
          </span>
        )}
        <span
          className={cn(
            "flex min-h-11 min-w-11 items-center justify-end",
            onRightTimeClick &&
              "cursor-pointer hover:text-white transition-colors"
          )}
          onClick={onRightTimeClick}
          onKeyDown={(event) => handleActivationKey(event, onRightTimeClick)}
          role={onRightTimeClick ? "button" : undefined}
          tabIndex={onRightTimeClick ? 0 : undefined}
          aria-label={onRightTimeClick ? "切换剩余时间显示" : undefined}
        >
          {formatMediaTime(duration)}
        </span>
      </div>
    </div>
  );
}
