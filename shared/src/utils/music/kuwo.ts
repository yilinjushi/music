import type { MusicTrack } from "../../types/music";
import { normalizePersistableResourceUrl } from "../url";
import type {
  KuwoPlaylistDetail,
  KuwoPlaylistResponse,
  KuwoSongRaw,
} from "../../types/music-platforms";

// ============================================================
// 常量
// ============================================================

export const KUWO_PAGE_SIZE = 100;
export const KUWO_MAX_PLAYLIST_PAGES = 5;
export const KUWO_MAX_PLAYLIST_TRACKS =
  KUWO_PAGE_SIZE * KUWO_MAX_PLAYLIST_PAGES;
export const KUWO_PLAYLIST_WALL_CLOCK_MS = 10_000;

function assertKuwoPlaylistBudget(startedAt: number): void {
  if (Date.now() - startedAt >= KUWO_PLAYLIST_WALL_CLOCK_MS) {
    throw new Error("Kuwo playlist import exceeded its time budget");
  }
}

function assertKuwoTrackCount(total: number): void {
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    total > KUWO_MAX_PLAYLIST_TRACKS
  ) {
    throw new Error("Kuwo playlist exceeds the safe track limit");
  }
}

// ============================================================
// URL 构建
// ============================================================

export function buildKuwoPlaylistApiPath(
  playlistId: string,
  page = 0,
  pageSize = KUWO_PAGE_SIZE
): string {
  const params = new URLSearchParams({
    op: "getlistinfo",
    pid: playlistId,
    pn: String(page),
    rn: String(pageSize),
    encode: "utf-8",
    keyset: "pl2012",
    identity: "kuwo",
    vipver: "MUSIC_9.1.1.2_BCS2",
    newver: "1",
  });
  return `/pl.svc?${params.toString()}`;
}

// ============================================================
// 解析
// ============================================================

export function parseKuwoPlaylistResponse(text: string): KuwoPlaylistResponse {
  return JSON.parse(text) as KuwoPlaylistResponse;
}

// ============================================================
// 歌曲转换
// ============================================================

function splitArtists(artist?: string): string[] {
  return (artist || "未知歌手")
    .split(/[、/&]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

export function convertKuwoSongToMusicTrack(song: KuwoSongRaw): MusicTrack {
  const rawId =
    song.rid ||
    song.id ||
    song.musicrid?.replace(/^MUSIC_/, "") ||
    song.name ||
    "unknown";
  const coverUrl = normalizePersistableResourceUrl(song.albumpic || song.pic);

  return {
    id: `kuwo_${rawId}`,
    name: song.name || song.songname || "未知歌曲",
    artist: splitArtists(song.artist),
    album: song.album || "",
    pic_id: coverUrl,
    url_id: String(rawId),
    lyric_id: String(rawId),
    source: "kuwo",
    album_id: song.albumid ? String(song.albumid) : undefined,
  };
}

// ============================================================
// I/O 抽象：分页拉取
// ============================================================

export async function fetchKuwoPlaylistDetail(
  playlistId: string,
  fetchText: (path: string) => Promise<string>
): Promise<KuwoPlaylistDetail> {
  const startedAt = Date.now();
  const response = parseKuwoPlaylistResponse(
    await fetchText(buildKuwoPlaylistApiPath(playlistId, 0))
  );
  assertKuwoPlaylistBudget(startedAt);
  if (response.result !== "ok") {
    throw new Error(response.msg || "酷我歌单接口返回异常");
  }

  const songs = [...(response.musiclist || [])];
  const total = response.total || songs.length;
  assertKuwoTrackCount(total);
  if (songs.length > KUWO_MAX_PLAYLIST_TRACKS) {
    throw new Error("Kuwo playlist exceeds the safe track limit");
  }
  for (
    let page = 1;
    total > songs.length && page < KUWO_MAX_PLAYLIST_PAGES;
    page += 1
  ) {
    assertKuwoPlaylistBudget(startedAt);
    const pageResponse = parseKuwoPlaylistResponse(
      await fetchText(buildKuwoPlaylistApiPath(playlistId, page))
    );
    assertKuwoPlaylistBudget(startedAt);
    if (pageResponse.result !== "ok") {
      throw new Error(pageResponse.msg || "酷我歌单接口返回异常");
    }
    const pageSongs = pageResponse.musiclist || [];
    if (!pageSongs.length) break;
    if (songs.length + pageSongs.length > KUWO_MAX_PLAYLIST_TRACKS) {
      throw new Error("Kuwo playlist exceeds the safe track limit");
    }
    songs.push(...pageSongs);
  }

  if (total > songs.length) {
    throw new Error("Kuwo playlist response was incomplete");
  }

  if (!songs.length) throw new Error("歌单为空，无法导入");

  return {
    name: response.title || `酷我歌单 ${playlistId}`,
    coverUrl: normalizePersistableResourceUrl(
      response.pic || songs.find((song) => song.albumpic)?.albumpic
    ),
    trackCount: total || songs.length,
    songs,
  };
}
