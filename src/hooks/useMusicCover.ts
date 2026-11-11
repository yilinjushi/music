import { logger } from "@/lib/logger";
import { getStoredCoverUrl, storeCover } from "@/lib/cover-cache";
import { canUseNetwork } from "@/lib/network-policy";
import { forceHttps } from "@shared/utils/url";
import type { MusicTrack } from "@/types/music";
import { useState, useEffect } from "react";

export function useMusicCover(
  track: MusicTrack | null | undefined,
  enabled: boolean = true
) {
  const [state, setState] = useState<{
    url: string | null;
    picId: string | undefined;
    source: string | undefined;
  }>({
    url: null,
    picId: undefined,
    source: undefined,
  });

  useEffect(() => {
    if (!track?.pic_id || !enabled) {
      return;
    }

    let active = true;
    const { pic_id, source } = track;

    const fetchCover = async () => {
      try {
        const { musicApi } = await import("@/lib/music-api");
        // Cellular / "local only": never ask the network for a cover. Only a
        // direct image link can be looked up on the phone without a request.
        if (!canUseNetwork()) {
          const stored = pic_id.startsWith("http")
            ? await getStoredCoverUrl(forceHttps(pic_id))
            : null;
          if (active) setState({ url: stored, picId: pic_id, source });
          return;
        }
        const url = await musicApi.getPic(pic_id, source);
        // Keep a copy on the phone for later playback without network.
        if (url?.startsWith("http") && pic_id.startsWith("http")) {
          void storeCover(forceHttps(pic_id));
        }
        if (active) {
          setState({ url, picId: pic_id, source });
        }
      } catch (e) {
        logger.error("MusicCover", "Failed to fetch cover", e);
        if (active) {
          setState({ url: null, picId: pic_id, source });
        }
      }
    };

    fetchCover();

    return () => {
      active = false;
    };
  }, [track?.pic_id, track?.source, enabled]);

  // Derived state: if disabled or no track, return null.
  // If the current track doesn't match what we've loaded, return null (it's loading).
  if (
    !enabled ||
    !track?.pic_id ||
    track.pic_id !== state.picId ||
    track.source !== state.source
  ) {
    return null;
  }

  return state.url;
}
