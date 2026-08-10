"use client";

import { HardDrive } from "lucide-react";
import { PageLayout } from "./PageLayout";
import type { MusicTrack } from "@/types/music";

interface LocalMusicPageProps {
  onBack?: () => void;
  onPlay: (track: MusicTrack, list: MusicTrack[], contextId?: string) => void;
  currentTrackKey?: string | null;
  isPlaying: boolean;
}

/**
 * Device-wide file scanning belonged to the removed Android runtime. Keep the
 * historical route safe for old bookmarks and persisted navigation state.
 */
export function LocalMusicPage({ onBack }: LocalMusicPageProps) {
  return (
    <PageLayout title="本地音乐" onBack={onBack}>
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <HardDrive className="mb-4 h-14 w-14 text-muted-foreground/30" />
        <h2 className="text-base font-medium">浏览器无法读取原设备音乐目录</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          旧版 Android
          本地曲目记录不会在网页中打开。你仍可使用网页歌单、搜索和下载功能。
        </p>
      </div>
    </PageLayout>
  );
}
