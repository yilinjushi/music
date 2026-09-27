import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Music2 } from "lucide-react";
import { NeteaseDetail } from "@/components/NeteaseDetail";
import { NeteaseLogin } from "@/components/settings/NeteaseLogin";
import { PageLoader } from "@/components/PageLoader";
import { getNeteaseSession } from "@/lib/netease/netease-api";
import { useNeteaseStore } from "@/store/netease-store";
import { usePlayHelper } from "@/hooks/usePlayHelper";
import { useMusicStore } from "@/store/music-store";
import { getOptionalTrackIdentityKey } from "@/lib/utils/track-identity";
import {
  getUnavailableTrackIds,
  requestNeteasePlaylistSync,
} from "@/lib/audio-cache";

const HOME_PLAYLIST_ID = "neplaylist_366135532";
const HOME_REFRESH_AFTER_MS = 30_000;
const HOME_SYNC_DELAY_MS = 20_000;

function HomeLoginGate() {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-4 pb-bottom-stack">
      <div className="w-full max-w-md rounded-2xl border border-border/60 bg-card/70 p-5 shadow-sm backdrop-blur-sm">
        <div className="mb-4 text-center">
          <Music2 className="mx-auto mb-3 h-9 w-9 text-primary" />
          <h1 className="text-lg font-semibold">登录网易云音乐</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            登录后，首页会直接打开你的“我喜欢的音乐”。
          </p>
        </div>
        <NeteaseLogin autoOpen />
      </div>
    </div>
  );
}

export function HomeRoute() {
  const navigate = useNavigate();
  const authenticated = useNeteaseStore((state) => state.authenticated);
  const setSession = useNeteaseStore((state) => state.setSession);
  const clearSession = useNeteaseStore((state) => state.clearSession);
  const { handlePlay } = usePlayHelper();
  const currentTrackKey = useMusicStore((state) =>
    getOptionalTrackIdentityKey(state.queue[state.currentIndex])
  );
  const isPlaying = useMusicStore((state) => state.isPlaying);
  const [sessionState, setSessionState] = useState<
    "checking" | "authenticated" | "unauthenticated"
  >("checking");

  useEffect(() => {
    const controller = new AbortController();
    void getNeteaseSession(controller.signal)
      .then((profile) => {
        if (controller.signal.aborted) return;
        if (profile) {
          setSession(profile);
          setSessionState("authenticated");
        } else {
          clearSession();
          setSessionState("unauthenticated");
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        clearSession();
        setSessionState("unauthenticated");
      });

    return () => controller.abort();
  }, [clearSession, setSession]);

  useEffect(() => {
    if (sessionState === "authenticated" && !authenticated) {
      setSessionState("unauthenticated");
    }
  }, [authenticated, sessionState]);

  useEffect(() => {
    if (sessionState === "unauthenticated" && authenticated) {
      setSessionState("authenticated");
    }
  }, [authenticated, sessionState]);

  // iPhone 上 PWA 从后台切回时不会重新加载页面；离开超过 30 秒就重新拉取
  // 红心歌单，让网易云客户端里新加心的歌自动同步过来。
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else if (hiddenAt && Date.now() - hiddenAt > HOME_REFRESH_AFTER_MS) {
        hiddenAt = 0;
        setRefreshKey((key) => key + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // 每次打开/切回红心页：让服务端在后台把下一批歌存进对象存储，并拿到
  // 确认没有任何音源的歌，从列表里隐藏。
  const [hiddenTrackIds, setHiddenTrackIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  useEffect(() => {
    if (sessionState !== "authenticated") return;
    const controller = new AbortController();
    // Let the list load first so background work never competes with it.
    const syncTimer = window.setTimeout(
      () => requestNeteasePlaylistSync(HOME_PLAYLIST_ID),
      HOME_SYNC_DELAY_MS
    );
    void getUnavailableTrackIds(HOME_PLAYLIST_ID, controller.signal).then(
      (ids) => {
        if (!controller.signal.aborted) setHiddenTrackIds(new Set(ids));
      }
    );
    return () => {
      controller.abort();
      window.clearTimeout(syncTimer);
    };
  }, [sessionState, refreshKey]);

  if (sessionState === "checking") return <PageLoader />;
  if (sessionState === "unauthenticated") return <HomeLoginGate />;

  return (
    <NeteaseDetail
      id={HOME_PLAYLIST_ID}
      type="playlist"
      onBack={() => navigate("/search")}
      onPlay={(track, list) => handlePlay(track, list, "home_netease_playlist")}
      currentTrackKey={currentTrackKey}
      isPlaying={isPlaying}
      refreshKey={refreshKey}
      hiddenTrackIds={hiddenTrackIds}
      compact
    />
  );
}
