import type { MusicTrack } from "@/types/music";
import { normalizePersistableResourceUrl } from "@shared/utils/url";

type CreatePlaylist = (
  name: string,
  coverUrl?: string,
  tracks?: MusicTrack[]
) => string;

export function normalizeNeteaseDetailCover(value: string): string {
  return normalizePersistableResourceUrl(value);
}

/** Commit a detail import through the store's atomic validated entry point. */
export function createNeteaseDetailPlaylist(
  createPlaylist: CreatePlaylist,
  detail: { name: string; coverImgUrl: string },
  tracks: MusicTrack[]
): string {
  return createPlaylist(
    detail.name,
    normalizeNeteaseDetailCover(detail.coverImgUrl) || undefined,
    tracks
  );
}
