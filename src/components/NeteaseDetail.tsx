import { useEffect, useState, useRef, useMemo } from "react";
import { filterTracks } from "@/lib/utils/filter-tracks";
import { useLocation, useNavigate } from "react-router-dom";
import { MusicTrackList } from "@/components/MusicTrackList";
import {
  GenericDetailPage,
  type GenericDetailData,
} from "@/components/GenericDetailPage";
import {
  getPlaylistDetail,
  getArtist,
  getAlbum,
  getArtistSongs,
  convertSongToMusicTrack,
  toggleSubAlbum,
  getAlbumDynamicDetail,
} from "@/lib/netease/netease-api";
import { MusicTrack } from "@/types/music";
import {
  MoreVertical,
  Import,
  SquareArrowOutUpRight,
  Album,
  Bookmark,
  ListMusic,
  Download,
  Search,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { DetailSkeleton } from "@/components/skeletons/DetailSkeleton";
import toast from "react-hot-toast";
import { writeClipboardText } from "@/lib/clipboard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useMusicStore } from "@/store/music-store";
import { useNeteaseStore } from "@/store/netease-store";
import { SongDetail } from "@/lib/netease/netease-raw-types";
import { ArtistAlbumSheet } from "@/components/ArtistAlbumSheet";
import type { ArtistAlbumSheetNavigationState } from "@/lib/navigation/netease-detail-navigation";
import { useArtistAlbumSheet } from "@/hooks/useArtistAlbumSheet";
import { useMarketSession } from "@/store/session/market-session";
import { logger } from "@/lib/logger";
import { useDetailPage } from "@/hooks/useDetailPage";
import { useExitLayer } from "@/hooks/useExitLayer";
import {
  createNeteaseDetailPlaylist,
  normalizeNeteaseDetailCover,
} from "@/lib/netease/netease-detail-import";
import {
  getOfflineTrackIds,
  getPlaylistCacheStatus,
  requestNeteasePlaylistSync,
  type PlaylistCacheStatus,
} from "@/lib/audio-cache";
import {
  getOfflineUsage,
  syncOfflineAudio,
  type OfflineSyncProgress,
} from "@/lib/offline-audio";
import { readHomeList, writeHomeList } from "@/lib/home-list-cache";

const LOAD_MORE_RETRY_DELAYS_MS = [1_500, 4_000];

interface NeteaseDetailProps {
  id: string | null;
  type?: "playlist" | "artist" | "album";
  onBack: () => void;
  onPlay: (track: MusicTrack, list: MusicTrack[]) => void;
  currentTrackKey?: string | null;
  isPlaying?: boolean;
  /** Changing this value refetches the detail (e.g. when the PWA resumes). */
  refreshKey?: number;
  /** NetEase song ids with no playable source; hidden from the list. */
  hiddenTrackIds?: ReadonlySet<string>;
  /** Home 红心 layout: no page title bar, one compact header row. */
  compact?: boolean;
}

interface UnifiedDetail {
  name: string;
  coverImgUrl: string;
  description?: string;
  creator?: string;
  trackCount: number;
  albumCount?: number;
  publishTime?: number;
  sub?: boolean;
  playCount?: number;
  creatorId?: string | number;
  hasMore?: boolean;
  nextOffset?: number;
}

const NETEASE_PLAYLIST_PAGE_SIZE = 100;

export function NeteaseDetail({
  id,
  type = "playlist",
  onBack,
  onPlay,
  currentTrackKey,
  isPlaying,
  refreshKey = 0,
  hiddenTrackIds,
  compact = false,
}: NeteaseDetailProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const autoLoadFailedRef = useRef(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<PlaylistCacheStatus | null>(
    null
  );

  const createPlaylist = useMusicStore((state) => state.createPlaylist);
  const isShuffle = useMusicStore((state) => state.isShuffle);
  const { authenticated } = useNeteaseStore();
  const { toggleAlbumInSession } = useMarketSession();
  const navigationState =
    (location.state as ArtistAlbumSheetNavigationState | null | undefined) ??
    null;
  const { push: pushExitLayer, pop: popExitLayer } = useExitLayer();

  const {
    isOpen: isAlbumSheetOpen,
    setIsOpen: setIsAlbumSheetOpen,
    handleBack,
  } = useArtistAlbumSheet({
    id,
    type,
    navigationState,
    pathname: location.pathname,
    navigate,
    pushExitLayer,
    popExitLayer,
  });

  const { loading, error, detail, tracks, setDetail, setTracks, retry } =
    useDetailPage<UnifiedDetail>(
      async (signal) => {
        if (!id) throw new Error("No id");

        let rawDetail: UnifiedDetail;
        let rawTracks: SongDetail[];

        if (type === "playlist") {
          const res = await getPlaylistDetail(id, "", signal);
          if (!res) throw new Error("Not found");
          rawDetail = {
            name: res.name,
            coverImgUrl: normalizeNeteaseDetailCover(res.coverImgUrl),
            description: res.description,
            creator: res.creator?.nickname,
            trackCount: res.trackCount,
            playCount: res.playCount,
            creatorId: res.creator?.userId,
            hasMore: res.hasMore ?? res.trackCount > res.tracks.length,
            nextOffset: res.nextOffset ?? res.tracks.length,
          };
          rawTracks = res.tracks;
        } else if (type === "artist") {
          const res = await getArtist(id);
          if (!res) throw new Error("Not found");
          rawDetail = {
            name: res.artist.name,
            coverImgUrl: normalizeNeteaseDetailCover(res.artist.picUrl),
            description: res.artist.briefDesc,
            trackCount: res.artist.musicSize,
            albumCount: res.artist.albumSize,
            hasMore: res.artist.musicSize > res.hotSongs.length,
            nextOffset: res.hotSongs.length,
          };
          rawTracks = res.hotSongs;
        } else {
          const [res, dynamicRes] = await Promise.all([
            getAlbum(id),
            getAlbumDynamicDetail(id).catch(() => null),
          ]);
          if (!res?.album) throw new Error("Not found");
          rawDetail = {
            name: res.album.name,
            coverImgUrl: normalizeNeteaseDetailCover(res.album.picUrl),
            description: res.album.description,
            creator: res.album.artist?.name,
            trackCount: res.songs.length,
            publishTime: res.album.publishTime,
            sub: dynamicRes?.isSub || false,
            hasMore: false,
            nextOffset: res.songs.length,
          };
          rawTracks = res.songs;
        }

        const result = {
          detail: rawDetail,
          tracks: rawTracks.map((s) => convertSongToMusicTrack(s)),
        };
        if (compact && type === "playlist") writeHomeList(id, result);
        return result;
      },
      [id, type, authenticated, refreshKey],
      compact && type === "playlist" && id
        ? readHomeList<UnifiedDetail>(id)
        : null
    );

  useEffect(() => {
    if (detail && (type === "artist" || type === "playlist")) {
      const initialOffset = detail.nextOffset ?? tracks.length;
      setOffset(initialOffset);
      setHasMore(detail.hasMore ?? detail.trackCount > initialOffset);
    } else {
      setOffset(0);
      setHasMore(false);
    }
    // The detail object changes once per page navigation/retry. Track appends
    // must not reset the continuation offset back to the first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, detail]);

  // Background cache progress (the server syncs in bounded steps; this only
  // reads its latest status).
  useEffect(() => {
    setCacheStatus(null);
    if (!id || type !== "playlist" || !authenticated) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      if (document.hidden) return;
      const next = await getPlaylistCacheStatus(id);
      if (cancelled || !next) return;
      setCacheStatus(next);
      // Nothing left to cache: stop asking every 15s.
      if (next.ready + next.unavailable.length >= next.total) {
        window.clearInterval(timer);
      }
    };
    void poll();
    timer = window.setInterval(() => void poll(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id, type, authenticated]);

  // Home (红心) only: after the app has settled, ask the server to pick up
  // newly liked songs, then mirror every cached song onto the phone.
  const [offline, setOffline] = useState<OfflineSyncProgress | null>(null);
  const [offlineBytes, setOfflineBytes] = useState<number | null>(null);
  useEffect(() => {
    if (!compact || !id || type !== "playlist" || !authenticated) return;
    let cancelled = false;
    const timers: number[] = [];
    let waitingForVisible: (() => void) | null = null;
    const run = async (round: number) => {
      if (cancelled) return;
      // Background = no network/disk work; resume once the app is visible.
      if (document.visibilityState === "hidden") {
        if (waitingForVisible) return;
        waitingForVisible = () => {
          if (document.visibilityState === "hidden") return;
          document.removeEventListener("visibilitychange", waitingForVisible!);
          waitingForVisible = null;
          void run(round);
        };
        document.addEventListener("visibilitychange", waitingForVisible);
        return;
      }
      requestNeteasePlaylistSync(id);
      const ids = await getOfflineTrackIds(id);
      if (cancelled || !ids) return;
      await syncOfflineAudio(ids, (progress) => {
        if (!cancelled) setOffline(progress);
      });
      const usage = await getOfflineUsage();
      if (!cancelled && usage) setOfflineBytes(usage.usedBytes);
      // New likes need a server round first; look again a few times.
      if (round < 3) {
        timers.push(window.setTimeout(() => void run(round + 1), 90_000));
      }
    };
    // Let the last song resume and the list render before any downloads.
    timers.push(window.setTimeout(() => void run(0), 10_000));
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
      if (waitingForVisible)
        document.removeEventListener("visibilitychange", waitingForVisible);
    };
  }, [compact, id, type, authenticated]);

  const onHeaderBack = () => {
    handleBack(onBack);
  };

  const handleShare = async () => {
    if (!detail || !id) return;
    const typeLabel = { playlist: "歌单", artist: "歌手", album: "专辑" }[type];
    const ok = await writeClipboardText(
      `【网易云${typeLabel}】${detail.name}\nhttps://music.163.com/#/${type}?id=${id}`
    );
    if (ok) {
      toast.success("链接已复制");
    } else {
      toast.error("复制失败");
    }
  };

  const handleImportPlaylist = () => {
    if (!detail || !tracks.length) return;
    const toastId = toast.loading(`正在导入 ${tracks.length} 首歌曲...`);
    try {
      createNeteaseDetailPlaylist(createPlaylist, detail, tracks);
      toast.success(`成功导入 ${tracks.length} 首歌曲`, { id: toastId });
    } catch {
      toast.error("导入失败", { id: toastId });
    }
  };

  // Songs in the latest list that are neither cached nor known sourceless.
  // Uses the live track count so newly liked songs are included right away.
  const uncachedCount = cacheStatus
    ? Math.max(
        0,
        (detail?.trackCount ?? cacheStatus.total) -
          cacheStatus.ready -
          cacheStatus.unavailable.length
      )
    : null;

  const handleCachePlaylist = () => {
    if (!id || type !== "playlist" || !authenticated) return;
    if (uncachedCount === 0) {
      toast.success("云端已全部缓存，无需手动缓存");
      return;
    }
    requestNeteasePlaylistSync(id);
    toast.success(
      uncachedCount === null
        ? "已开始缓存，已缓存的歌曲会自动跳过"
        : `还有 ${uncachedCount} 首未缓存，已开始缓存（已缓存的自动跳过，后台分批完成）`,
      { duration: 5000 }
    );
  };

  const handleToggleAlbumSub = async () => {
    if (!id || !authenticated || type !== "album" || !detail) return;
    const shouldSub = !detail.sub;

    if (!shouldSub && !confirm("确定不再收藏吗？")) return;

    try {
      let success = false;
      let msg = "";

      const res = await toggleSubAlbum(id, shouldSub);
      success = res.data?.code === 200;
      msg = res.data?.message || "";
      if (success) {
        toggleAlbumInSession(
          {
            id: Number(id),
            name: detail.name || "",
            picUrl: detail.coverImgUrl || "",
            artistName: detail.creator || "",
          },
          shouldSub
        );
      }

      if (success) {
        toast.success(shouldSub ? "收藏成功" : "已取消收藏");
        setDetail((prev) => (prev ? { ...prev, sub: shouldSub } : prev));
      } else {
        toast.error(msg || "操作失败");
      }
    } catch (err) {
      toast.error("操作失败");
      logger.error("NeteaseDetail", "Toggle album subscription failed", err, {
        id,
        type,
        shouldSub,
      });
    }
  };

  const visibleTracks = useMemo(
    () =>
      hiddenTrackIds?.size
        ? tracks.filter((track) => !hiddenTrackIds.has(track.id))
        : tracks,
    [tracks, hiddenTrackIds]
  );
  const filteredTracks = useMemo(
    () => filterTracks(visibleTracks, searchQuery),
    [visibleTracks, searchQuery]
  );

  const handleLoadMore = async () => {
    if (
      !id ||
      loadingMore ||
      loadingMoreRef.current ||
      !hasMore ||
      (type !== "artist" && type !== "playlist")
    )
      return;
    setLoadingMore(true);
    loadingMoreRef.current = true;
    try {
      if (type === "playlist") {
        // NetEase occasionally rejects a page under load; retry with backoff
        // before surfacing an error.
        let res: Awaited<ReturnType<typeof getPlaylistDetail>> | undefined;
        for (let attempt = 0; ; attempt += 1) {
          try {
            res = await getPlaylistDetail(id, "", undefined, {
              offset,
              limit: NETEASE_PLAYLIST_PAGE_SIZE,
            });
            break;
          } catch (error) {
            if (attempt >= LOAD_MORE_RETRY_DELAYS_MS.length) throw error;
            await new Promise((resolve) =>
              setTimeout(resolve, LOAD_MORE_RETRY_DELAYS_MS[attempt])
            );
          }
        }
        const newTracks =
          res?.tracks?.map((s) => convertSongToMusicTrack(s)) ?? [];
        const nextOffset =
          typeof res?.nextOffset === "number" && res.nextOffset > offset
            ? res.nextOffset
            : offset + newTracks.length;
        if (nextOffset <= offset) {
          setHasMore(false);
          return;
        }
        setTracks((prev) => [...prev, ...newTracks]);
        setOffset(nextOffset);
        setHasMore(
          res.hasMore ??
            (detail?.trackCount
              ? nextOffset < detail.trackCount
              : newTracks.length > 0)
        );
        return;
      }

      const res = await getArtistSongs(id, 50, offset);
      if (res?.songs?.length) {
        const newTracks = res.songs.map((s) => convertSongToMusicTrack(s));
        setTracks((prev) => [...prev, ...newTracks]);

        const nextOffset = offset + newTracks.length;
        setOffset(nextOffset);
        setHasMore(
          detail?.trackCount
            ? nextOffset < detail.trackCount && (res.more ?? true)
            : (res.more ?? true)
        );
      } else {
        setHasMore(false);
      }
    } catch (err) {
      // Stop the automatic page chain; the user can still retry manually.
      autoLoadFailedRef.current = true;
      toast.error("加载更多失败");
      logger.error("NeteaseDetail", "Load more artist songs failed", err, {
        id,
        type,
        offset,
      });
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  // Playlists load every page automatically so the full list (and play
  // queue) is available without scrolling to "加载更多".
  useEffect(() => {
    autoLoadFailedRef.current = false;
  }, [id, refreshKey]);
  useEffect(() => {
    if (
      type !== "playlist" ||
      !hasMore ||
      loading ||
      loadingMore ||
      autoLoadFailedRef.current
    ) {
      return;
    }
    void handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, hasMore, loading, loadingMore, offset]);

  const genericDetail: GenericDetailData | undefined = detail
    ? {
        title: detail.name,
        coverUrl: detail.coverImgUrl,
        description: detail.description,
        creator: detail.creator,
        countDesc: `${detail.trackCount} 首`,
        publishTime: detail.publishTime,
        fallbackIcon: <ListMusic className="h-8 w-8 text-primary/80" />,
      }
    : undefined;

  const action = (
    <div className="flex items-center">
      {type === "artist" && (
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setIsAlbumSheetOpen(true)}
          aria-label="查看歌手专辑"
        >
          <Album className="w-5 h-5" />
        </Button>
      )}
      {authenticated && type === "album" && (
        <Button
          variant="ghost"
          size="icon"
          className={
            detail?.sub
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground"
          }
          onClick={handleToggleAlbumSub}
          aria-label={detail?.sub ? "取消收藏专辑" : "收藏专辑"}
        >
          <Bookmark
            className={`w-5 h-5 ${detail?.sub ? "fill-current" : ""}`}
          />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="更多详情操作"
            className={
              compact
                ? "h-11 w-9 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }
          >
            <MoreVertical className={compact ? "h-6 w-6" : "w-5 h-5"} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={handleShare}>
            <SquareArrowOutUpRight className="w-4 h-4 mr-2" />
            分享
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleImportPlaylist}>
            <Import className="w-4 h-4 mr-2" />
            导入歌单
          </DropdownMenuItem>
          {authenticated && type === "playlist" && (
            <DropdownMenuItem onClick={handleCachePlaylist}>
              <Download className="w-4 h-4 mr-2" />
              {uncachedCount === null
                ? "缓存到云端"
                : uncachedCount === 0
                  ? "云端已全部缓存"
                  : `缓存到云端（还有 ${uncachedCount} 首未缓存）`}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const trackList = (
    headerLead?: React.ReactNode,
    headerActions?: React.ReactNode
  ) => (
    <MusicTrackList
      tracks={filteredTracks}
      scrollContainerRef={scrollRef}
      onPlay={(track) => onPlay(track, visibleTracks)}
      currentTrackKey={currentTrackKey}
      isPlaying={isPlaying}
      emptyMessage="列表为空"
      onLoadMore={
        type === "artist" || type === "playlist" ? handleLoadMore : undefined
      }
      hasMore={hasMore}
      loading={loading || loadingMore}
      headerLead={headerLead}
      headerActions={headerActions}
    />
  );

  if (compact && loading) return <DetailSkeleton onBack={onHeaderBack} bare />;

  if (compact && !loading && !error && detail) {
    const total = detail.trackCount;
    const cached = cacheStatus?.ready ?? 0;
    const unavailableCount = cacheStatus?.unavailable.length ?? 0;
    const cloudStatusText = [
      cached >= total - unavailableCount
        ? "云端已全部缓存"
        : `云端已缓存 ${cached}/${total}`,
      `无音源 ${unavailableCount} 首`,
      offline
        ? `手机已存 ${offline.stored}/${offline.total}${
            offline.running ? "（下载中）" : ""
          }${
            offlineBytes ? ` · ${(offlineBytes / 1024 ** 3).toFixed(1)} GB` : ""
          }`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const headerLead = searchOpen ? (
      <Input
        autoFocus
        placeholder="搜索红心"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="h-11 text-base"
      />
    ) : (
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-xl font-bold tabular-nums text-foreground">
            {cached}/{total}
          </span>
          <span className="text-xs text-muted-foreground">
            {cloudStatusText}
          </span>
        </div>
      </div>
    );
    const headerActions = (
      <>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-9 text-foreground"
          onClick={() => {
            if (searchOpen) setSearchQuery("");
            setSearchOpen(!searchOpen);
          }}
          aria-label={searchOpen ? "关闭搜索" : "搜索"}
        >
          {searchOpen ? (
            <X className="h-6 w-6" />
          ) : (
            <Search className="h-6 w-6" />
          )}
        </Button>
        {action}
      </>
    );
    return (
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto overscroll-y-contain custom-scrollbar"
      >
        <div className="pb-bottom-stack">
          {trackList(headerLead, headerActions)}
        </div>
      </div>
    );
  }

  return (
    <GenericDetailPage
      loading={loading}
      error={error}
      title="详情"
      onBack={onHeaderBack}
      onRetry={retry}
      detail={genericDetail}
      scrollRef={scrollRef}
      action={action}
      isShuffle={isShuffle}
      tracks={visibleTracks}
      onPlayTrack={
        visibleTracks.length > 0
          ? (track) => onPlay(track, visibleTracks)
          : undefined
      }
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
    >
      <div className="flex-1 min-h-0">{trackList()}</div>
      <ArtistAlbumSheet
        artistId={id}
        isOpen={isAlbumSheetOpen}
        onOpenChange={setIsAlbumSheetOpen}
        artistName={detail?.name}
        albumCount={detail?.albumCount}
      />
    </GenericDetailPage>
  );
}
