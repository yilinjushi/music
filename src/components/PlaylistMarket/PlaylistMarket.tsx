import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NETEASE_CATS,
  SPECIAL_CATS,
  RECOMMEND_CATS,
} from "@/lib/netease/netease-cats";
import {
  getPlaylists,
  getToplist,
  searchPlaylists,
} from "@/lib/netease/netease-api";
import type { MarketPlaylist } from "@/lib/netease/netease-types";
import { Loader2, LayoutGrid, X } from "lucide-react";
import { PlaylistCategorySelector } from "./PlaylistCategorySelector";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { useMusicStore } from "@/store/music-store";
import { useScrollSave } from "@/hooks/use-scroll-save";
import { usePagination } from "@/hooks/use-pagination";
import { useMarketSession } from "@/store/session/market-session";
import { MineSection } from "./MineSection";
import { PlaylistGrid } from "./PlaylistGrid";
import { logger } from "@/lib/logger";
import { cachedFetch } from "@/lib/utils/cache";
import { createNeteaseMarketCacheKey } from "./market-cache-key";

const PAGE_SIZE = 30;
const SUB_TAB_HEIGHT = "h-8";

export const PLAYLIST_MARKET_ROOT_CLASS_NAME =
  "flex h-full flex-col bg-background";

const getSnapshotKey = (category: string, tab: string) =>
  `market-snapshot:${category}:${category === "featured" ? tab : "default"}`;

const MARKET_CATEGORY_IDS = new Set([
  ...RECOMMEND_CATS.map((category) => category.id),
  ...SPECIAL_CATS.map((category) => category.id),
  ...NETEASE_CATS.flatMap((group) => group.filters.map((item) => item.id)),
]);

export function PlaylistMarket() {
  const navigate = useNavigate();
  const rawLastCategory = useMusicStore((s) => s.lastPlaylistCategory);
  const activeCategory = MARKET_CATEGORY_IDS.has(rawLastCategory)
    ? rawLastCategory
    : "全部";
  const setActiveCategory = useMusicStore((s) => s.setLastPlaylistCategory);
  const featuredTab = useMusicStore(
    (s) => s.lastFeaturedTab || SPECIAL_CATS[0].id
  );
  const setFeaturedTab = useMusicStore((s) => s.setLastFeaturedTab);
  const [searchInputValue, setSearchInputValue] = useState("");
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const saveListSnapshot = useMarketSession((s) => s.saveListSnapshot);
  const searchCache = useMarketSession((s) => s.searchCache);
  const saveSearchCache = useMarketSession((s) => s.saveSearchCache);

  const searchKeywordRef = useRef<string>("");

  const snapshotKey = useMemo(
    () => getSnapshotKey(activeCategory, featuredTab),
    [activeCategory, featuredTab]
  );

  const isBrowseEnabled =
    activeCategory !== "mine" && !(activeCategory === "全部" && !!searchQuery);

  const isSearchEnabled = activeCategory === "全部" && !!searchQuery;

  const browseAdapter = useMemo(
    () => ({
      fetch: async (offset: number) => {
        const category =
          activeCategory === "featured" ? featuredTab : activeCategory;
        if (category === "mine") return null;
        const isToplist = category === "toplist";
        // The explicit NetEase namespace makes cachedFetch treat these
        // same-origin, potentially personalized results as session-bound, so
        // the helper never writes them to Cache Storage or SWR state.
        const res = await cachedFetch<MarketPlaylist[]>(
          createNeteaseMarketCacheKey(category, isToplist ? 0 : offset),
          () =>
            isToplist
              ? getToplist("")
              : getPlaylists(category || "全部", "hot", PAGE_SIZE, offset, ""),
          24 * 60 * 60 * 1000
        );

        if (!res) return null;
        return {
          items: res,
          hasMore: isToplist ? false : res.length >= PAGE_SIZE,
        };
      },
    }),
    [activeCategory, featuredTab]
  );

  const browse = usePagination<MarketPlaylist>({
    adapter: browseAdapter,
    getId: (p) => p.id,
    pageSize: PAGE_SIZE,
    enabled: isBrowseEnabled,
    onError: (err, offset) =>
      logger.error("PlaylistMarket", "Market load failed", err, {
        category: activeCategory,
        featuredTab,
        offset,
      }),
  });

  const searchAdapter = useMemo(
    () => ({
      fetch: async (offset: number) => {
        const keyword = searchKeywordRef.current;
        if (!keyword) return null;
        const page = offset / PAGE_SIZE + 1;
        const res = await searchPlaylists(keyword, page, PAGE_SIZE);
        if (!res) return null;
        return { items: res, hasMore: res.length >= PAGE_SIZE };
      },
    }),
    []
  );

  const search = usePagination<MarketPlaylist>({
    adapter: searchAdapter,
    getId: (p) => p.id,
    pageSize: PAGE_SIZE,
    enabled: isSearchEnabled,
    onError: (err, offset) =>
      logger.error("PlaylistMarket", "Playlist search failed", err, {
        keyword: searchKeywordRef.current,
        offset,
      }),
  });

  // Save browse snapshots
  useEffect(() => {
    if (!isBrowseEnabled || browse.items.length === 0) return;
    const key = getSnapshotKey(activeCategory, featuredTab);
    saveListSnapshot(key, {
      items: browse.items,
      offset: browse.offset,
      hasMore: browse.hasMore,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browse.items, browse.offset, browse.hasMore]);

  // Save search cache
  useEffect(() => {
    if (searchQuery && search.items.length >= 0) {
      saveSearchCache({
        query: searchQuery,
        items: search.items,
        offset: search.offset,
        hasMore: search.hasMore,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, search.items, search.offset, search.hasMore]);

  // Category switch
  useEffect(() => {
    if (activeCategory === "全部") {
      if (searchCache) {
        setSearchInputValue(searchCache.query);
        setSearchQuery(searchCache.query);
        searchKeywordRef.current = searchCache.query;
        search.restore({
          items: searchCache.items,
          offset: searchCache.offset,
          hasMore: searchCache.hasMore,
        });
      } else {
        setSearchInputValue("");
        setSearchQuery(null);
        searchKeywordRef.current = "";
      }
    } else {
      setSearchInputValue("");
      setSearchQuery(null);
    }

    if (activeCategory === "mine") return;

    const snapshot = useMarketSession.getState().listSnapshots[snapshotKey];
    if (snapshot) {
      browse.restore({
        items: snapshot.items,
        offset: snapshot.offset,
        hasMore: snapshot.hasMore,
      });
      return;
    }

    browse.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategory, featuredTab, snapshotKey]);

  const handleSearchSubmit = useCallback(
    (keyword: string) => {
      const trimmed = keyword.trim();
      if (!trimmed) {
        if (searchQuery) {
          setSearchQuery(null);
          searchKeywordRef.current = "";
          saveSearchCache(null);
        }
        return;
      }
      searchKeywordRef.current = trimmed;
      setSearchQuery(trimmed);
      search.reset();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchQuery, saveSearchCache]
  );

  const clearSearch = useCallback(() => {
    setSearchInputValue("");
    setSearchQuery(null);
    searchKeywordRef.current = "";
    saveSearchCache(null);
  }, [saveSearchCache]);

  const { scrollRef } = useScrollSave(
    `scroll-${snapshotKey}`,
    !searchQuery && (browse.items.length > 0 || activeCategory === "mine")
  );

  const displayFilters = useMemo(() => {
    const base = [...RECOMMEND_CATS];
    if (!activeCategory || base.some((f) => f.id === activeCategory))
      return base;
    return [...base, { id: activeCategory, name: activeCategory }];
  }, [activeCategory]);

  // Scroll active category into view
  useEffect(() => {
    const activeBtn = scrollContainerRef.current?.querySelector(
      `[data-category-id="${activeCategory}"]`
    );
    if (activeBtn) {
      activeBtn.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    }
  }, [activeCategory]);

  const isSearchActive = activeCategory === "全部" && !!searchQuery;
  const active = isSearchActive ? search : browse;

  return (
    <div className={PLAYLIST_MARKET_ROOT_CLASS_NAME}>
      <header className="sticky top-0 z-20 bg-background backdrop-blur-xl border-b border-border/20 shadow-sm">
        <div className="flex items-center justify-between px-3 py-1.5 gap-2">
          <div className="flex-1 overflow-hidden relative">
            <div
              ref={scrollContainerRef}
              className="flex items-center gap-1.5 overflow-x-auto no-scrollbar mask-[linear-gradient(to_right,black_calc(100%-32px),transparent_100%)]"
            >
              {displayFilters.map((f) => (
                <Button
                  key={f.id}
                  data-category-id={f.id}
                  variant="ghost"
                  size="sm"
                  onClick={() => setActiveCategory(f.id)}
                  className={cn(
                    "h-8 px-3 rounded-full transition-all text-xs font-medium whitespace-nowrap shrink-0",
                    activeCategory === f.id
                      ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
                      : "text-muted-foreground hover:text-foreground bg-secondary/30"
                  )}
                >
                  {f.name}
                </Button>
              ))}
              <div className="w-4 shrink-0" />
            </div>
          </div>
          <PlaylistCategorySelector
            activeCategory={activeCategory}
            onSelect={setActiveCategory}
            trigger={
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 rounded-full shrink-0 bg-secondary/50 hover:bg-secondary"
                aria-label="选择歌单分类"
              >
                <LayoutGrid className="h-4 w-4 text-muted-foreground" />
              </Button>
            }
          />
        </div>
      </header>

      <main ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar">
        {activeCategory === "mine" ? (
          <MineSection />
        ) : (
          <div className="p-4 pb-bottom-stack">
            {activeCategory === "全部" && (
              <div
                className={cn(
                  "flex items-center justify-between mb-4 px-1 gap-4 transition-all duration-300",
                  SUB_TAB_HEIGHT
                )}
              >
                <div className="relative flex-1 group max-w-32">
                  <Input
                    value={searchInputValue}
                    onChange={(e) => setSearchInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleSearchSubmit(searchInputValue);
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    placeholder="歌单广场"
                    className={cn(
                      "h-8 px-0 bg-transparent! shadow-none rounded-none transition-all duration-300",
                      "border-0 border-b border-dashed border-muted-foreground/20 focus-visible:border-solid",
                      "text-base font-semibold text-foreground",
                      "placeholder:text-foreground placeholder:font-semibold placeholder:text-base",
                      "focus-visible:ring-0 focus-visible:border-primary",
                      "focus-visible:placeholder:text-muted-foreground/40 focus-visible:placeholder:font-normal focus-visible:placeholder:text-xs"
                    )}
                  />

                  {searchInputValue && (
                    <button
                      type="button"
                      onClick={clearSearch}
                      className="touch-target absolute right-0 top-1/2 inline-flex -translate-y-1/2 items-center justify-center text-muted-foreground/40 hover:text-foreground transition-colors opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                      aria-label="清除"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <span className="text-xs font-medium text-foreground whitespace-nowrap shrink-0">
                  共 {active.items.length} 个歌单
                </span>
              </div>
            )}

            {activeCategory === "featured" && !isSearchActive && (
              <div
                className={cn(
                  "flex items-center gap-6 mb-4 px-1",
                  SUB_TAB_HEIGHT
                )}
              >
                {SPECIAL_CATS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setFeaturedTab(tab.id)}
                    className={cn(
                      "min-h-11 text-[15px] transition-all",
                      featuredTab === tab.id
                        ? "font-bold text-foreground tracking-wide"
                        : "font-medium text-muted-foreground hover:text-foreground"
                    )}
                    aria-pressed={featuredTab === tab.id}
                  >
                    {tab.name}
                  </button>
                ))}
              </div>
            )}

            {active.loading ? (
              <div className="h-60 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="text-xs tracking-widest uppercase opacity-50">
                  加载中...
                </span>
              </div>
            ) : (
              <PlaylistGrid
                list={active.items}
                onClick={(id) => navigate(`/netease-playlist/${id}`)}
              />
            )}

            <div
              ref={active.observerTargetRef}
              className="h-12 w-full mt-6 flex items-center justify-center opacity-80"
            >
              {active.fetching && !active.loading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>加载中...</span>
                </div>
              )}
              {!active.hasMore && active.items.length > 0 && (
                <span className="text-xs text-muted-foreground/50 tracking-wide uppercase">
                  没有更多了-_-
                </span>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
