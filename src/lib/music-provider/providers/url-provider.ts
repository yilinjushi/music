import type {
  MusicTrack,
  SearchIntent,
  SearchPageResult,
  SongLyric,
} from "@/types/music";
import type { IMusicProvider } from "../interface";

/** Provider for user-supplied HTTPS media URLs saved in a playlist. */
export class UrlProvider implements IMusicProvider {
  source = "url" as const;

  async search(
    _query: string,
    _page: number,
    _count: number,
    _signal?: AbortSignal,
    _intent?: SearchIntent
  ): Promise<SearchPageResult<MusicTrack>> {
    return { items: [], hasMore: false };
  }

  async getUrl(track: MusicTrack): Promise<string | null> {
    return track.url_id || null;
  }

  async getPic(track: MusicTrack): Promise<string | null> {
    return track.pic_id || null;
  }

  async getLyric(_track: MusicTrack): Promise<SongLyric | null> {
    return null;
  }
}
