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

const HOME_PLAYLIST_ID = "neplaylist_366135532";

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
    />
  );
}
