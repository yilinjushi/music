import { MusicTrack } from "@/types/music";
import { toastUtils } from "@/lib/utils/toast";
import { logger } from "@/lib/logger";
import {
  assertNoSensitiveData,
  requireSafeTrack,
} from "@/lib/utils/sensitive-data";
interface PlaylistBackup {
  name: string;
  tracks: MusicTrack[];
  createdAt: number;
}

const MAX_PLAYLIST_BACKUP_BYTES = 8 * 1024 * 1024;
const MAX_PLAYLIST_BACKUP_TRACKS = 1_000;

/**
 * 导出歌单
 */
export async function exportPlaylist(name: string, tracks: MusicTrack[]) {
  if (!tracks || tracks.length === 0) {
    toastUtils.error("歌单为空，无法导出");
    return;
  }

  assertNoSensitiveData(name);
  if (!name.trim() || name.length > 256) {
    throw new Error("歌单名称格式不正确");
  }
  const backupData: PlaylistBackup = {
    name,
    tracks: tracks.map(requireSafeTrack),
    createdAt: Date.now(),
  };

  const jsonContent = JSON.stringify(backupData, null, 2);
  const fileName = `${name.replace(/[\\/:*?"<>|]/g, "_")}.json`;
  try {
    const blob = new Blob([jsonContent], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toastUtils.success("导出成功");
  } catch (error) {
    logger.error("playlist-backup", "Export playlist failed", error, {
      name,
      trackCount: tracks.length,
      platform: "web",
    });
    toastUtils.error("导出失败");
  }
}

/**
 * 导入歌单
 */
export async function importPlaylist(
  file: File
): Promise<{ name: string; tracks: MusicTrack[] }> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_PLAYLIST_BACKUP_BYTES) {
      reject(new Error("歌单文件过大"));
      return;
    }
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        if (!content) {
          throw new Error("文件内容为空");
        }

        const data = JSON.parse(content);
        assertNoSensitiveData(data);

        // 校验数据格式
        let tracks: unknown[] = [];
        let name = file.name.replace(/\.json$/i, "");

        if (Array.isArray(data)) {
          // 兼容纯数组格式
          tracks = data;
        } else if (data && typeof data === "object") {
          // 标准备份格式
          if (Array.isArray(data.tracks)) {
            tracks = data.tracks;
            if (data.name !== undefined) {
              if (typeof data.name !== "string") {
                throw new Error("歌单名称格式不正确");
              }
              name = data.name;
            }
          } else {
            // 尝试判断是否是单个 track
            if (data.id && data.name && data.source) {
              tracks = [data];
            }
          }
        }

        if (!tracks || tracks.length === 0) {
          throw new Error("未找到有效的歌曲数据");
        }
        if (tracks.length > MAX_PLAYLIST_BACKUP_TRACKS) {
          throw new Error("歌曲数量超过导入上限");
        }
        assertNoSensitiveData(name);
        if (!name.trim() || name.length > 256) {
          throw new Error("歌单名称格式不正确");
        }

        // Backups are restored atomically. Silently filtering a malformed
        // recording would make the reported and durable track counts diverge.
        const isValidTrack = (t: unknown): t is MusicTrack => {
          if (typeof t !== "object" || t === null) return false;
          const track = t as Record<string, unknown>;
          return typeof track.id === "string" && typeof track.name === "string";
        };
        if (!tracks.every(isValidTrack)) {
          throw new Error("歌曲数据格式不正确");
        }

        const sanitizedTracks = tracks.map(requireSafeTrack);
        resolve({ name, tracks: sanitizedTracks });
      } catch (error) {
        logger.error("playlist-backup", "Import playlist failed", error, {
          fileName: file.name,
        });
        reject(error);
      }
    };

    reader.onerror = () => {
      reject(new Error("读取文件失败"));
    };

    reader.readAsText(file);
  });
}
