import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface MusicLayoutProps {
  children: ReactNode;
  player: ReactNode;
  tabBar: ReactNode;
  header?: ReactNode;
  hidePlayer?: boolean;
  className?: string;
  isTab?: boolean;
  /** 页面自己管理滚动（如歌曲列表）时，外层不允许滑动 */
  lockScroll?: boolean;
}

export function MusicLayout({
  children,
  player,
  tabBar,
  header,
  hidePlayer,
  className,
  isTab = true,
  lockScroll = false,
}: MusicLayoutProps) {
  return (
    <div
      className={cn(
        "relative flex flex-col h-dvh overflow-hidden bg-background pt-safe",
        isTab && "pt-11",
        className
      )}
    >
      {/* Header */}
      {header && <div className="shrink-0 px-5 pb-3">{header}</div>}

      {/* Main Content */}
      <div className="flex-1 min-h-0 relative">
        <div
          className={cn(
            "h-full scrollbar-hide overscroll-none",
            lockScroll ? "overflow-hidden" : "overflow-auto"
          )}
        >
          {children}
        </div>
      </div>

      {/* Now Playing Bar (Floating Island) */}
      {!hidePlayer && (
        <div
          className={cn(
            "flex-none z-50 absolute left-0 right-0 transition-all duration-300",
            isTab ? "bottom-(--tab-bar-safe-height)" : "bottom-0"
          )}
        >
          {player}
        </div>
      )}

      {/* Tab Bar */}
      {isTab && <div className="flex-none z-40">{tabBar}</div>}
    </div>
  );
}
