import { IMusicProvider } from "../interface";
import {
  MusicTrack,
  SearchPageResult,
  SongLyric,
  SearchIntent,
} from "@/types/music";
import { logger } from "@/lib/logger";

export class LocalProvider implements IMusicProvider {
  source = "local" as const;
  async search(
    _query: string,
    _page: number,
    _count: number,
    _signal?: AbortSignal,
    _intent?: SearchIntent
  ): Promise<SearchPageResult<MusicTrack>> {
    return { items: [], hasMore: false };
  }

  async getUrl(track: MusicTrack, _br?: number): Promise<string | null> {
    const url = track.url_id?.trim();
    if (/^(blob:|data:audio\/|https?:\/\/)/i.test(url)) return url;
    logger.warn(
      "local-provider",
      "Legacy device-local track is unavailable in the browser"
    );
    return null;
  }

  async getPic(track: MusicTrack, _size?: number): Promise<string | null> {
    if (!track.pic_id) return null;

    return /^(blob:|data:image\/|https?:\/\/)/i.test(track.pic_id)
      ? track.pic_id
      : null;
  }

  async getLyric(_track: MusicTrack): Promise<SongLyric | null> {
    return null;
  }
}
