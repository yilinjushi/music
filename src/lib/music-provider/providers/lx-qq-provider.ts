import { QqApiProvider } from "./qq-api-provider";
import type {
  MusicTrack,
  SearchPageResult,
  SearchIntent,
  MusicSource,
} from "@/types/music";
import { getLxUrl } from "@/lib/utils/lx-api";

/** Legacy LX/QQ tracks fail closed until a dedicated same-origin LX BFF exists. */
export class LxQqProvider extends QqApiProvider {
  source: MusicSource = "lx_qq";

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
    let songid = track.url_id || track.lyric_id;
    if (!songid) return null;
    if (songid.startsWith("qq_")) songid = songid.slice(3);
    return getLxUrl("lx_qq", songid, br);
  }
}
