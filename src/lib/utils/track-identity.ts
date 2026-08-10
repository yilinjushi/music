import type { MusicSource, MusicTrack } from "@/types/music";

/**
 * The smallest stable identity accepted for a track anywhere in client state.
 * Provider ids are not globally unique, and some providers use a distinct
 * url_id for different playable recordings under the same catalog id.
 */
export type TrackIdentity = Pick<MusicTrack, "id" | "source"> & {
  /** Missing legacy url_id is canonicalized to the same value as an empty id. */
  url_id?: string | null;
};

export function normalizeTrackUrlId(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

export function getTrackIdentityKey(track: TrackIdentity): string {
  return JSON.stringify([
    track.source,
    track.id,
    normalizeTrackUrlId(track.url_id),
  ]);
}

export function getOptionalTrackIdentityKey(
  track: TrackIdentity | null | undefined
): string | null {
  return track ? getTrackIdentityKey(track) : null;
}

export function getTrackOccurrenceKeys(tracks: MusicTrack[]): string[] {
  const counts = new Map<string, number>();
  return tracks.map((track) => {
    const identityKey = getTrackIdentityKey(track);
    const occurrence = counts.get(identityKey) ?? 0;
    counts.set(identityKey, occurrence + 1);
    return JSON.stringify([
      track.source,
      track.id,
      normalizeTrackUrlId(track.url_id),
      occurrence,
    ]);
  });
}

export function isSameTrackIdentity(
  left: TrackIdentity | null | undefined,
  right: TrackIdentity | null | undefined
): boolean {
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.source === right.source &&
    normalizeTrackUrlId(left.url_id) === normalizeTrackUrlId(right.url_id)
  );
}

export function trackIdentityFromParts(
  id: string,
  source: MusicSource,
  urlId: string | undefined
): TrackIdentity {
  return { id, source, url_id: urlId ?? "" };
}

/** Prefer the exact in-memory occurrence, then fall back to composite identity. */
export function findTrackIdentityIndex(
  tracks: MusicTrack[],
  target: TrackIdentity
): number {
  const referenceIndex = tracks.indexOf(target as MusicTrack);
  return referenceIndex >= 0
    ? referenceIndex
    : tracks.findIndex((candidate) => isSameTrackIdentity(candidate, target));
}

/** Remove one occurrence only; identical rows elsewhere remain independent. */
export function removeOneTrackIdentity(
  tracks: MusicTrack[],
  target: TrackIdentity
): MusicTrack[] {
  const index = findTrackIdentityIndex(tracks, target);
  if (index < 0) return tracks;
  return [...tracks.slice(0, index), ...tracks.slice(index + 1)];
}
