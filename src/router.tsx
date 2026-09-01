import { createBrowserRouter } from "react-router-dom";
import { Suspense, lazy } from "react";
import { RootLayout } from "@/components/RootLayout";
import { RouteErrorPage } from "@/components/RouteErrorPage";
import { PageLoader } from "@/components/PageLoader";
import { SearchRoute } from "@/routes/SearchRoute";
import { SettingsRoute } from "@/routes/SettingsRoute";
const HomeRoute = lazy(() =>
  import("@/routes/HomeRoute").then((module) => ({
    default: module.HomeRoute,
  }))
);
const FavoritesRoute = lazy(() =>
  import("@/routes/RouteWrappers").then((module) => ({
    default: module.FavoritesRoute,
  }))
);
const MineRoute = lazy(() =>
  import("@/routes/RouteWrappers").then((module) => ({
    default: module.MineRoute,
  }))
);
const PlaylistDetailRoute = lazy(() =>
  import("@/routes/RouteWrappers").then((module) => ({
    default: module.PlaylistDetailRoute,
  }))
);
const MarketPlaylistDetailRoute = lazy(() =>
  import("@/routes/RouteWrappers").then((module) => ({
    default: module.MarketPlaylistDetailRoute,
  }))
);
const ArtistDetailRoute = lazy(() =>
  import("@/routes/RouteWrappers").then((module) => ({
    default: module.ArtistDetailRoute,
  }))
);
const AlbumDetailRoute = lazy(() =>
  import("@/routes/RouteWrappers").then((module) => ({
    default: module.AlbumDetailRoute,
  }))
);
const QueueRoute = lazy(() =>
  import("@/routes/RouteWrappers").then((module) => ({
    default: module.QueueRoute,
  }))
);
const HistoryRoute = lazy(() =>
  import("@/routes/RouteWrappers").then((module) => ({
    default: module.HistoryRoute,
  }))
);
const TrashRoute = lazy(() =>
  import("@/routes/RouteWrappers").then((module) => ({
    default: module.TrashRoute,
  }))
);
const BilibiliCollectionDetailRoute = lazy(() =>
  import("@/routes/RouteWrappers").then((module) => ({
    default: module.BilibiliCollectionDetailRoute,
  }))
);

function lazyRoute(Component: React.ComponentType) {
  return (
    <Suspense fallback={<PageLoader />}>
      <Component />
    </Suspense>
  );
}

// --- Router Config ---

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        index: true,
        element: <HomeRoute />,
      },
      {
        path: "search",
        element: <SearchRoute />,
      },
      {
        path: "favorites",
        element: lazyRoute(FavoritesRoute),
      },
      {
        path: "mine",
        element: lazyRoute(MineRoute),
      },
      {
        path: "playlist/:id",
        element: lazyRoute(PlaylistDetailRoute),
      },
      {
        path: "netease-playlist/:id",
        element: lazyRoute(MarketPlaylistDetailRoute),
      },
      {
        path: "netease-artist/:id",
        element: lazyRoute(ArtistDetailRoute),
      },
      {
        path: "netease-album/:id",
        element: lazyRoute(AlbumDetailRoute),
      },
      {
        path: "bilibili-collection/:id",
        element: lazyRoute(BilibiliCollectionDetailRoute),
      },
      {
        path: "queue",
        element: lazyRoute(QueueRoute),
      },
      {
        path: "history",
        element: lazyRoute(HistoryRoute),
      },
      {
        path: "settings",
        element: <SettingsRoute />,
      },
      {
        path: "settings/trash",
        element: lazyRoute(TrashRoute),
      },
    ],
  },
]);
