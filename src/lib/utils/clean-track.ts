import type { MergedMusicTrack, MusicTrack } from "@/types/music";
import { requireSafeTrack } from "./sensitive-data";

/**
 * Remove runtime-only fields before a track is persisted or synchronized.
 *
 * Keep this helper dependency-free: music stores use it while they are being
 * initialized, so importing UI or a store barrel here creates a bootstrap
 * cycle and pulls unrelated providers into the initial bundle.
 */
export function cleanTrack(track: MusicTrack | MergedMusicTrack): MusicTrack {
  return requireSafeTrack(track);
}
