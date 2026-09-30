import { Outlet, useLocation } from "react-router-dom";
import { MusicLayout } from "@/components/MusicLayout";
import { MusicTabBar } from "@/components/MusicTabBar";
import { useExitLayer } from "@/hooks/useExitLayer";
import { useEffect, lazy, Suspense } from "react";

const PlayerBarHost = lazy(() =>
  import("@/components/PlayerHosts").then((module) => ({
    default: module.PlayerBarHost,
  }))
);

const PlayerRuntimeHost = lazy(() =>
  import("@/components/PlayerHosts").then((module) => ({
    default: module.PlayerRuntimeHost,
  }))
);

const PlayerAudioHost = lazy(() =>
  import("@/components/PlayerHosts").then((module) => ({
    default: module.PlayerAudioHost,
  }))
);

const ROOT_TAB_PATHS = ["/", "/search", "/favorites", "/mine"] as const;
const isRootTabPath = (path: string) =>
  ROOT_TAB_PATHS.includes(path as (typeof ROOT_TAB_PATHS)[number]);

export function RootLayout() {
  const location = useLocation();
  const { handleExit: handleExitLayer } = useExitLayer();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;

      const handled = handleExitLayer();
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleExitLayer]);

  const isTab = isRootTabPath(location.pathname);

  return (
    <>
      <MusicLayout
        isTab={isTab}
        lockScroll={location.pathname === "/"}
        player={
          <Suspense fallback={null}>
            <PlayerBarHost isTab={isTab} />
          </Suspense>
        }
        tabBar={<MusicTabBar />}
      >
        <Outlet />
      </MusicLayout>

      <Suspense fallback={null}>
        <PlayerAudioHost />
      </Suspense>

      <Suspense fallback={null}>
        <PlayerRuntimeHost />
      </Suspense>
    </>
  );
}
