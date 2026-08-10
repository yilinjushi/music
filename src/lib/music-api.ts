import type {
  MusicSource,
  MusicTrack,
  SearchPageResult,
  MergedMusicTrack,
  SongLyric,
  SearchIntent,
  SearchSuggestionItem,
} from "@/types/music";
import { cachedFetch, deleteCachedValue } from "@/lib/utils/cache";
import { searchSuggest } from "@/lib/netease/netease-api";
import { MusicProviderFactory, isAbort } from "./music-provider";
import { logger } from "@/lib/logger";

const TTL_LONG = 7 * 24 * 60 * 60 * 1000; // 7 days

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error("MUSIC_API_REQUEST_ABORTED"), {
      name: "AbortError",
    });
  }
}

export const musicApi = {
  /* ---------------- 搜索 ---------------- */

  async search(
    query: string,
    source: MusicSource = "joox",
    page = 1,
    count = 20,
    signal?: AbortSignal,
    searchIntent?: SearchIntent | null
  ): Promise<SearchPageResult<MusicTrack>> {
    if (source === "all") {
      return this.searchAll(query, page, count, signal, searchIntent);
    }

    return MusicProviderFactory.getProvider(source).search(
      query,
      page,
      count,
      signal,
      searchIntent
    );
  },

  /* ---------------- 全网搜索 ---------------- */

  async searchAll(
    query: string,
    page = 1,
    count = 20,
    signal?: AbortSignal,
    searchIntent?: SearchIntent | null
  ): Promise<SearchPageResult<MergedMusicTrack>> {
    const provider = MusicProviderFactory.getProvider("all");
    return provider.search(query, page, count, signal, searchIntent) as Promise<
      SearchPageResult<MergedMusicTrack>
    >;
  },

  /* ---------------- 最佳匹配搜索（串行） ---------------- */

  async searchBestMatch({
    query,
    sources,
    predicate,
    count = 20,
    signal,
    ranker,
    targetTrack,
  }: {
    query: string;
    sources: MusicSource[];
    predicate?: (track: MusicTrack) => boolean;
    count?: number;
    signal?: AbortSignal;
    ranker?: (track: MusicTrack, originalIndex: number) => number;
    targetTrack?: MusicTrack;
  }): Promise<MusicTrack | null> {
    for (const source of sources) {
      if (signal?.aborted) return null;
      try {
        const provider = MusicProviderFactory.getProvider(source);
        const callerPredicate = predicate ?? (() => true);
        const providerPredicate =
          targetTrack && provider.getAutoMatchPredicate
            ? provider.getAutoMatchPredicate(targetTrack)
            : null;
        // Provider-specific matching can add evidence (for example a Bilibili
        // uploader/title blob), but may never replace the caller's safety gate.
        const effectivePredicate = providerPredicate
          ? (track: MusicTrack) =>
              callerPredicate(track) && providerPredicate(track)
          : callerPredicate;
        const effectiveQuery =
          targetTrack && provider.getAutoMatchQuery
            ? provider.getAutoMatchQuery(targetTrack, query)
            : query;
        const effectiveCount =
          targetTrack && provider.getAutoMatchCount
            ? provider.getAutoMatchCount(targetTrack)
            : count;
        const effectiveRanker =
          targetTrack && provider.getAutoMatchRanker
            ? provider.getAutoMatchRanker(targetTrack)
            : ranker;
        const res = await provider.search(
          effectiveQuery,
          1,
          effectiveCount,
          signal
        );
        const match = effectiveRanker
          ? res.items
              .map((track, originalIndex) => ({ track, originalIndex }))
              .filter(({ track }) => effectivePredicate(track))
              .sort(
                (a, b) =>
                  effectiveRanker(b.track, b.originalIndex) -
                    effectiveRanker(a.track, a.originalIndex) ||
                  a.originalIndex - b.originalIndex
              )[0]?.track
          : res.items.find(effectivePredicate);
        if (match) return match;
      } catch (e) {
        if (isAbort(e)) throw e;
        logger.warn("music-api", `Search failed for source: ${source}`, e);
      }
    }
    return null;
  },

  /* ---------------- URL ---------------- */

  async getUrl(
    track: MusicTrack,
    br = 192,
    signal?: AbortSignal
  ): Promise<string | null> {
    throwIfAborted(signal);

    // Resolved media URLs are frequently short-lived bearer capabilities.
    // Keep them out of Cache Storage entirely; audio-resolver owns the
    // session-memory cache and checks its AbortSignal before writing there.
    try {
      const url = await MusicProviderFactory.getProvider(track.source).getUrl(
        track,
        br,
        signal
      );
      throwIfAborted(signal);
      return url;
    } catch (error) {
      if (signal?.aborted || isAbort(error)) throw error;
      logger.error("music-api", "getUrl failed", error);
      return null;
    }
  },

  async deleteUrlCache(
    track: MusicTrack,
    br = 192,
    signal?: AbortSignal
  ): Promise<void> {
    // New releases never write provider URLs to Cache Storage. Delete the old
    // exact key during recovery so upgrades cannot reuse a legacy capability.
    const legacyCandidates =
      track.source === "local" || track.source === "url"
        ? [track.url_id ?? track.id]
        : [track.id, track.url_id];
    const legacyIds = new Set(
      legacyCandidates.filter(
        (id): id is string => typeof id === "string" && !id.startsWith("http")
      )
    );
    for (const id of legacyIds) {
      throwIfAborted(signal);
      await deleteCachedValue(`url:${track.source}:${id}:${br}`, signal);
    }
  },

  /* ---------------- 封面 ---------------- */

  async getPic(
    idOrUrl: string,
    source: MusicSource,
    size: number = 800
  ): Promise<string | null> {
    if (idOrUrl.startsWith("http") && source !== "bilibili") return idOrUrl;
    const key = `pic:${source}:${idOrUrl}:${size}`;
    return cachedFetch<string | null>(
      key,
      async () => {
        try {
          const track = { id: idOrUrl, pic_id: idOrUrl, source } as MusicTrack;
          return await MusicProviderFactory.getProvider(source).getPic(
            track,
            size
          );
        } catch (e) {
          logger.error("music-api", "getPic failed", e);
          return null;
        }
      },
      TTL_LONG
    );
  },

  /* ---------------- 歌词 ---------------- */

  async getLyric(
    id: string,
    source: MusicSource,
    signal?: AbortSignal
  ): Promise<SongLyric | null> {
    const key = `lyric:${source}:${id}`;

    return cachedFetch<SongLyric | null>(
      key,
      async () => {
        try {
          const track = { id, lyric_id: id, source } as MusicTrack;
          return await MusicProviderFactory.getProvider(source).getLyric(
            track,
            signal
          );
        } catch (e) {
          if (signal?.aborted || isAbort(e)) throw e;
          logger.error("music-api", "getLyric failed", e);
          return null;
        }
      },
      TTL_LONG,
      signal
    );
  },

  /* ---------------- 搜索建议 ---------------- */

  async getSearchSuggestions(query: string): Promise<SearchSuggestionItem[]> {
    const q = query.trim();
    if (!q) return [];

    try {
      const s = await searchSuggest(q);
      if (!s) return [];

      const seen = new Set<string>();
      const suggestions: SearchSuggestionItem[] = [];

      const pushUnique = (
        text: string,
        type: SearchSuggestionItem["type"],
        id?: string | number
      ) => {
        text = text.trim();
        if (!text) return;

        const key = `${type}:${text}`;
        if (seen.has(key)) return;

        seen.add(key);
        suggestions.push({
          text,
          type,
          id: id === null ? undefined : String(id),
          source: "_netease",
        });
      };

      const addTop = <T>(
        list: T[] | undefined,
        type: SearchSuggestionItem["type"],
        format: (item: T) => string
      ) => {
        for (const item of list?.slice(0, 3) ?? []) {
          pushUnique(format(item), type, (item as { id?: string | number }).id);
        }
      };

      addTop(s.artists, "artist", (a) => a.name);
      addTop(
        s.songs,
        "song",
        (song) =>
          `${song.name} - ${song.artists?.map((a) => a.name).join("/") ?? ""}`
      );
      addTop(s.albums, "album", (a) => `${a.name} - ${a.artist?.name ?? ""}`);
      addTop(s.playlists, "playlist", (p) => p.name);

      return suggestions;
    } catch (e) {
      logger.warn("music-api", "Search suggest failed", e);
      return [];
    }
  },
};
