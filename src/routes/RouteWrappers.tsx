import { Suspense, lazy } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMusicStore } from "@/store/music-store";
import { useHistoryStore } from "@/store/history-store";
import { usePlayHelper } from "@/hooks/usePlayHelper";
import { usePlayContextHandler } from "@/hooks/usePlayContextHandler";
import { PageLoader } from "@/components/PageLoader";
import { PageLayout } from "@/components/PageLayout";
import { MusicPlaylistView } from "@/components/MusicPlaylistView";
import { ListMusic } from "lucide-react";
import { useActivePlaylists } from "@/hooks/use-active-playlists";
import { getOptionalTrackIdentityKey } from "@/lib/utils/track-identity";

// ==========================================
// 1. 懒加载路由组件 (保持极速首屏)
// ==========================================
const FavoritesView = lazy(() =>
  import("@/components/FavoritesView").then((m) => ({
    default: m.FavoritesView,
  }))
);
const MinePage = lazy(() =>
  import("@/components/MinePage").then((m) => ({ default: m.MinePage }))
);
const QueuePage = lazy(() =>
  import("@/components/QueuePage").then((m) => ({ default: m.QueuePage }))
);
const HistoryPage = lazy(() =>
  import("@/components/HistoryPage").then((m) => ({ default: m.HistoryPage }))
);
const NeteaseDetail = lazy(() =>
  import("@/components/NeteaseDetail").then((m) => ({
    default: m.NeteaseDetail,
  }))
);
const TrashPage = lazy(() =>
  import("@/components/TrashPage").then((m) => ({ default: m.TrashPage }))
);
const BilibiliCollectionDetail = lazy(() =>
  import("@/components/BilibiliCollectionDetail").then((m) => ({
    default: m.BilibiliCollectionDetail,
  }))
);

// ==========================================
// 2. 核心优化 Hooks & HOC
// ==========================================

/** * 精确订阅播放状态
 * 避免组件因为 queue 数组本身的变化（如添加/删除歌曲）而产生无意义的重渲染
 */
function usePlaybackState() {
  const currentTrackKey = useMusicStore((s) =>
    getOptionalTrackIdentityKey(s.queue[s.currentIndex])
  );
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const isShuffle = useMusicStore((s) => s.isShuffle);
  return { currentTrackKey, isPlaying, isShuffle };
}

/** 消除 Suspense 模板代码的高阶组件 */
function withSuspense<P extends object>(Component: React.ComponentType<P>) {
  return function RouteComponent(props: P) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Component {...props} />
      </Suspense>
    );
  };
}

// ==========================================
// 3. 路由组件实现
// ==========================================

export const FavoritesRoute = withSuspense(() => {
  const favorites = useMusicStore((s) => s.favorites);
  const activeFavorites = favorites.filter((t) => !t.is_deleted);
  const onPlay = usePlayContextHandler(activeFavorites, "favorites");
  const { currentTrackKey, isPlaying } = usePlaybackState();

  return (
    <FavoritesView
      tracks={activeFavorites}
      currentTrackKey={currentTrackKey}
      isPlaying={isPlaying}
      onPlay={onPlay}
      onReorder={(newOrder) =>
        useMusicStore.getState().reorderFavorites(newOrder)
      }
    />
  );
});

export const PlaylistDetailRoute = withSuspense(() => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const activePlaylists = useActivePlaylists();
  const playlist = activePlaylists.find((p) => p.id === id);
  const activeTracks = playlist?.tracks.filter((t) => !t.is_deleted) ?? [];
  const { currentTrackKey, isPlaying } = usePlaybackState();

  const onPlay = usePlayContextHandler(activeTracks, `playlist-${id}`);

  if (!playlist) {
    return (
      <div className="p-4 text-center text-muted-foreground">歌单不存在</div>
    );
  }

  return (
    <PageLayout title={playlist.name}>
      <MusicPlaylistView
        title={playlist.name}
        createdAt={playlist.createdAt}
        description={playlist.description}
        coverUrl={playlist.coverUrl}
        tracks={activeTracks}
        playlistId={id}
        icon={<ListMusic className="h-8 w-8 text-primary/80" />}
        onPlay={onPlay}
        onRemove={(track) =>
          useMusicStore.getState().removeFromPlaylist(id!, track)
        }
        onBatchRemove={(tracks) =>
          useMusicStore.getState().removeBatchFromPlaylist(id!, tracks)
        }
        onRename={(pid, newName) =>
          useMusicStore.getState().renamePlaylist(pid, newName)
        }
        onDelete={(pid) => {
          useMusicStore.getState().deletePlaylist(pid);
          navigate(-1);
        }}
        currentTrackKey={currentTrackKey}
        isPlaying={isPlaying}
      />
    </PageLayout>
  );
});

export const MineRoute = withSuspense(() => {
  const navigate = useNavigate();
  return <MinePage onSelectPlaylist={(id) => navigate(`/playlist/${id}`)} />;
});

// -- 网易云API详情路由复用逻辑 --
const createNeteaseRoute = (
  type: "playlist" | "artist" | "album",
  contextType: string
) => {
  return withSuspense(() => {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { handlePlay } = usePlayHelper();
    const { currentTrackKey, isPlaying } = usePlaybackState();

    return (
      <NeteaseDetail
        id={id || null}
        type={type}
        onBack={() => navigate(-1)}
        onPlay={(track, list) => handlePlay(track, list, contextType)}
        currentTrackKey={currentTrackKey}
        isPlaying={isPlaying}
      />
    );
  });
};

export const MarketPlaylistDetailRoute = createNeteaseRoute(
  "playlist",
  "playlist_market"
);
export const ArtistDetailRoute = createNeteaseRoute("artist", "artist");
export const AlbumDetailRoute = createNeteaseRoute("album", "album");

export const QueueRoute = withSuspense(() => {
  const queue = useMusicStore((s) => s.queue);
  const onPlay = usePlayContextHandler(queue, "queue");
  const { currentTrackKey, isPlaying } = usePlaybackState();

  return (
    <QueuePage
      queue={queue}
      currentTrackKey={currentTrackKey}
      isPlaying={isPlaying}
      onPlay={onPlay}
      onRemove={(track) => useMusicStore.getState().removeFromQueue(track)}
      onClear={() => useMusicStore.getState().clearQueue()}
    />
  );
});

export const HistoryRoute = withSuspense(() => {
  const history = useHistoryStore((s) => s.history);
  const onPlay = usePlayContextHandler(history, "history");
  const { currentTrackKey, isPlaying } = usePlaybackState();

  return (
    <HistoryPage
      history={history}
      currentTrackKey={currentTrackKey}
      isPlaying={isPlaying}
      onPlay={onPlay}
      onRemove={(track) => useHistoryStore.getState().removeFromHistory(track)}
      onClear={() => useHistoryStore.getState().clearHistory()}
    />
  );
});

export const TrashRoute = withSuspense(() => <TrashPage />);

export const BilibiliCollectionDetailRoute = withSuspense(() => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { handlePlay } = usePlayHelper();
  const { currentTrackKey, isPlaying } = usePlaybackState();

  return (
    <BilibiliCollectionDetail
      id={id || null}
      onBack={() => navigate(-1)}
      onPlay={(track, list) => handlePlay(track, list, "bilibili_collection")}
      currentTrackKey={currentTrackKey}
      isPlaying={isPlaying}
    />
  );
});
