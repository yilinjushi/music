import { MusicProviderFactory } from "@/lib/music-provider";
import { AUDIO_MIME, buildFileName } from "@/lib/storage-manager";
import type { MusicTrack } from "@/types/music";
import type { AudioFormat } from "@otter-music/shared";
import toast from "react-hot-toast";
import { useMusicStore } from "@/store/music-store";
import { toastUtils } from "./toast";
import { getProxyUrl, isProxyUrl } from "@/lib/api/config";
import { logger } from "@/lib/logger";
import { processBatchIO } from "@/lib/utils";
import { embedMetadata } from "./id3-embed";
import { getCachedBilibiliAudioFormat } from "@/lib/bilibili/bilibili-cache";
import {
  getTrackIdentityKey,
  isSameTrackIdentity,
  type TrackIdentity,
} from "./track-identity";

export interface LocalMusicFile {
  id: string;
  name: string;
  artist?: string;
  album?: string;
  duration?: number;
  localPath: string;
  fileSize?: number;
  modifiedTime?: number;
}

interface PerformDownloadOpts {
  skipMetadata?: boolean;
}

function getCurrentPlayingUrl(
  track: MusicTrack,
  downloadQuality: number
): string | null {
  const state = useMusicStore.getState();
  const currentTrack = state.queue[state.currentIndex];
  if (!currentTrack || !state.currentAudioUrl) return null;
  if (!isSameTrackIdentity(currentTrack, track)) {
    return null;
  }
  return (parseInt(state.quality) || 192) === downloadQuality
    ? state.currentAudioUrl
    : null;
}

function resolveAudioFormat(track: MusicTrack): AudioFormat | undefined {
  if (track.source === "bilibili") {
    return getCachedBilibiliAudioFormat(track) ?? "m4a";
  }
  return track.audioFormat;
}

export function buildDownloadKey(track: TrackIdentity) {
  return getTrackIdentityKey(track);
}

async function applyMetadata(
  blob: Blob,
  track: MusicTrack,
  toastId?: string,
  opts?: PerformDownloadOpts
): Promise<Blob> {
  if (opts?.skipMetadata) return blob;
  const store = useMusicStore.getState();
  if (!store.embedCover && !store.embedLyric) return blob;
  if (toastId) toast.loading("正在写入元数据...", { id: toastId });

  try {
    const result = await embedMetadata(blob, track, {
      embedCover: store.embedCover,
      embedLyric: store.embedLyric,
    });
    return result.blob;
  } catch (error) {
    logger.warn("download", "元数据嵌入失败", error);
    return blob;
  }
}

async function downloadInBrowser(
  url: string,
  fileName: string,
  track: MusicTrack,
  toastId?: string,
  opts?: PerformDownloadOpts
) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const format: AudioFormat = track.audioFormat ?? "mp3";
  const mime = AUDIO_MIME[format] ?? "audio/mpeg";
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body?.getReader();

  if (!reader) {
    const blob = await applyMetadata(
      await response.blob(),
      track,
      toastId,
      opts
    );
    triggerBlobDownload(blob, fileName, toastId);
    return;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total && toastId) {
      toast.loading(`下载 ${Math.round((received / total) * 100)}%`, {
        id: toastId,
      });
    }
  }

  const rawBlob = new Blob(chunks as BlobPart[], { type: mime });
  const blob = await applyMetadata(rawBlob, track, toastId, opts);
  triggerBlobDownload(blob, fileName, toastId);
}

async function performDownloadOne(
  track: MusicTrack,
  _br: number,
  toastId?: string,
  opts?: PerformDownloadOpts
): Promise<void> {
  const br = parseInt(useMusicStore.getState().downloadQuality) || 320;
  let url = getCurrentPlayingUrl(track, br);
  const reusedPlayingUrl = Boolean(url);

  if (!url) {
    url = await MusicProviderFactory.getProvider(track.source).getUrl(
      track,
      br
    );
  }
  if (!url) {
    for (const fallbackBr of [192, 128]) {
      if (fallbackBr >= br) continue;
      url = await MusicProviderFactory.getProvider(track.source).getUrl(
        track,
        fallbackBr
      );
      if (url) break;
    }
  }
  if (!url) throw new Error("无法获取下载链接");

  const format = resolveAudioFormat(track);
  const downloadTrack = format ? { ...track, audioFormat: format } : track;
  const fileName = buildFileName(downloadTrack);

  try {
    await downloadInBrowser(url, fileName, downloadTrack, toastId, opts);
  } catch (error) {
    if (reusedPlayingUrl) {
      const freshUrl = await MusicProviderFactory.getProvider(
        track.source
      ).getUrl(track, br);
      if (!freshUrl) throw new Error("无法获取下载链接", { cause: error });
      await downloadInBrowser(freshUrl, fileName, downloadTrack, toastId, opts);
      return;
    }
    if (isProxyUrl(url)) throw error;
    logger.warn(
      "download",
      "Direct download failed; using same-origin proxy",
      error
    );
    if (toastId) {
      toast.loading("已切换备用下载线路", { id: toastId, icon: "🌐" });
    }
    await downloadInBrowser(
      getProxyUrl(url),
      fileName,
      downloadTrack,
      toastId,
      opts
    );
  }
}

export async function downloadMusicTrack(track: MusicTrack, br = 192) {
  if (track.source === "local") {
    return toastUtils.info("本地音乐，无需下载");
  }
  const toastId = toast.loading(`准备下载: ${track.name}`);
  try {
    await performDownloadOne(track, br, toastId);
  } catch (error) {
    logger.error("downloadMusicTrack", "Download failed", error, {
      trackId: track.id,
      source: track.source,
    });
    const message = error instanceof Error ? error.message : String(error);
    toast.error(`下载失败: ${message}`, { id: toastId });
  }
}

export async function downloadMusicTrackBatch(tracks: MusicTrack[], br = 192) {
  const validTracks = tracks.filter((track) => track.source !== "local");
  if (!validTracks.length) return toastUtils.info("所选曲目无需下载");

  let done = 0;
  let failed = 0;
  const toastId = toast.loading(`准备下载 0/${validTracks.length}`);
  await processBatchIO(
    validTracks,
    async (track) => {
      try {
        await performDownloadOne(track, br);
      } catch (error) {
        failed += 1;
        logger.error("downloadMusicTrackBatch", `Failed: ${track.name}`, error);
      } finally {
        done += 1;
        toast.loading(`下载中 ${done}/${validTracks.length}`, { id: toastId });
      }
    },
    undefined,
    3
  );

  const succeeded = validTracks.length - failed;
  if (failed) {
    toastUtils.warning(`下载完成（成功 ${succeeded} / 失败 ${failed}）`, {
      id: toastId,
      duration: 5000,
    });
  } else {
    toast.success(`已成功下载全部 ${succeeded} 首`, {
      id: toastId,
      duration: 3000,
    });
  }
}

/** Kept for callers; browsers prompt for downloads without a storage grant. */
export async function ensurePermission(): Promise<void> {}

export function triggerBlobDownload(
  blob: Blob,
  filename: string,
  toastId?: string
) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  if (toastId) toast.success("下载完成", { id: toastId });
}

/** Historical device download records are not usable in a browser. */
export async function saveDownloadRecordsToDisk(
  _records: Record<string, unknown>
): Promise<void> {}

export async function loadDownloadRecordsFromDisk(): Promise<Record<
  string,
  unknown
> | null> {
  return null;
}

const LOCAL_ARTIST_SPLIT_RE = /[/、,，&＆;；|]/;
const LOCAL_ARTIST_DOUBLE_SPACE_RE = /\s{2,}/;

function getBasename(path: string) {
  const parts = path
    .replace(/^file:\/\//, "")
    .split(/[\\/]/)
    .filter(Boolean);
  return parts.at(-1) ?? "";
}

function getArtistFromLocalPath(localPath?: string | null) {
  if (!localPath) return null;
  const withoutExt = getBasename(localPath).replace(/\.[^/.]+$/, "");
  const separator = withoutExt.lastIndexOf(" - ");
  return separator > 0 ? withoutExt.slice(separator + 3).trim() || null : null;
}

export const convertToMusicTrack = (file: LocalMusicFile): MusicTrack => {
  const pathArtist = getArtistFromLocalPath(file.localPath);
  const artistText = (file.artist || pathArtist || "").trim();
  let artists = artistText
    ? artistText.split(
        LOCAL_ARTIST_SPLIT_RE.test(artistText)
          ? LOCAL_ARTIST_SPLIT_RE
          : LOCAL_ARTIST_DOUBLE_SPACE_RE
      )
    : [];
  artists = artists.map((artist) => artist.trim()).filter(Boolean);

  return {
    id: `local-${file.id}`,
    name: file.name || "未知歌曲",
    artist: artists.length ? artists : ["未知艺术家"],
    album: file.album || "",
    pic_id: file.localPath,
    url_id: file.localPath,
    lyric_id: file.localPath,
    source: "local",
  };
};
