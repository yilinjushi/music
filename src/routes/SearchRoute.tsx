import { MusicSearchView } from "@/components/MusicSearchView";
import { usePlayHelper } from "@/hooks/usePlayHelper";
import { useMusicStore } from "@/store/music-store";
import { getOptionalTrackIdentityKey } from "@/lib/utils/track-identity";

export function SearchRoute() {
  const { handlePlay } = usePlayHelper();
  const currentTrackKey = useMusicStore((state) =>
    getOptionalTrackIdentityKey(state.queue[state.currentIndex])
  );
  const isPlaying = useMusicStore((state) => state.isPlaying);

  return (
    <MusicSearchView
      onPlay={handlePlay}
      currentTrackKey={currentTrackKey}
      isPlaying={isPlaying}
    />
  );
}
