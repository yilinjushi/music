import { KuwoProvider } from "./kuwo-provider";
import type {
  MusicTrack,
  SearchPageResult,
  SongLyric,
  SearchIntent,
  MusicSource,
} from "@/types/music";
import { getLxUrl } from "@/lib/utils/lx-api";
import { requestMusicApiJSON } from "../utils";

/**
 * Legacy LX/Kuwo tracks keep metadata helpers, but discovery and playback are
 * fail-closed until a dedicated same-origin LX BFF exists.
 */
export class LxKuwoProvider extends KuwoProvider {
  source: MusicSource = "lx_kuwo";

  private static readonly API_SOURCE: MusicSource = "kuwo";

  async search(
    _query: string,
    _page: number,
    _count: number,
    _signal?: AbortSignal,
    _intent?: SearchIntent | null
  ): Promise<SearchPageResult<MusicTrack>> {
    return { items: [], hasMore: false };
  }

  async getUrl(track: MusicTrack, br?: number): Promise<string | null> {
    return getLxUrl("lx_kuwo", track.url_id, br);
  }

  async getPic(track: MusicTrack, size: number = 800): Promise<string | null> {
    const json = await requestMusicApiJSON<{ url?: string }>(
      { types: "pic", id: track.pic_id, size },
      LxKuwoProvider.API_SOURCE
    );
    return json.url || null;
  }

  async getLyric(
    track: MusicTrack,
    signal?: AbortSignal
  ): Promise<SongLyric | null> {
    const json = await requestMusicApiJSON<{ lyric?: string; tlyric?: string }>(
      { types: "lyric", id: track.lyric_id },
      LxKuwoProvider.API_SOURCE,
      signal
    );
    return { lyric: json.lyric ?? "", tlyric: json.tlyric ?? "" };
  }
}
