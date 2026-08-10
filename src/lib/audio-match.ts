import { toast } from "react-hot-toast";
import { useMusicStore, type MusicState } from "@/store/music-store";
import {
  EXCLUDED_FOR_SEARCH,
  getAggregatedSourcesForMatch,
} from "@/hooks/use-aggregated-sources";
import { musicApi } from "@/lib/music-api";
import { sourceLabels, type MusicSource, type MusicTrack } from "@/types/music";
import {
  haveSameArtistSet,
  isNameMatch,
  isSameRecordingVersion,
  normalizeArtists,
  normalizeIdentityText,
  normalizeText,
} from "./utils/music-key";
import { logger } from "@/lib/logger";
import { useUrlCacheStore, buildUrlCacheKey } from "@/store/url-cache-store";
import {
  trackMatchesIdentity,
  type IndexedTrackOwner,
  type MatchedTrackOwners,
  type PlaylistTrackOwner,
  type TrackIdentityTuple,
} from "@/store/music-store/playback-slice";
import { getTrackIdentityKey } from "@/lib/utils/track-identity";

const UNKNOWN_ARTIST_NAMES = new Set([
  "unknown",
  "unknownartist",
  "variousartists",
  "未知",
  "未知歌手",
  "群星",
]);
const UNKNOWN_ALBUM_NAMES = new Set([
  "unknown",
  "unknown album",
  "未知",
  "未知专辑",
]);

type MetadataComparison = "unknown" | "match" | "conflict";

let matchRequestGeneration = 0;
const latestMatchGenerationByOwner = new Map<string, number>();

function trackIdentity(track: MusicTrack): TrackIdentityTuple {
  return {
    id: track.id,
    source: track.source,
    urlId: track.url_id,
  };
}

function indexedOwner(index: number, track: MusicTrack): IndexedTrackOwner {
  return { index, ...trackIdentity(track) };
}

function findActiveTrackIndex(
  tracks: MusicTrack[],
  target: MusicTrack
): number {
  const referenceIndex = tracks.indexOf(target);
  if (referenceIndex >= 0 && !tracks[referenceIndex]?.is_deleted) {
    return referenceIndex;
  }
  const identity = trackIdentity(target);
  return tracks.findIndex(
    (candidate) =>
      !candidate.is_deleted && trackMatchesIdentity(candidate, identity)
  );
}

/**
 * Find the corresponding original-queue occurrence without falling back to an
 * id-wide replacement. References survive an in-memory shuffle; the identity
 * occurrence ordinal is the recovery path after a cloned state transition.
 */
function findOriginalQueueOwner(
  state: MusicState,
  queueOwner: IndexedTrackOwner
): IndexedTrackOwner | undefined {
  if (state.originalQueue.length === 0) return undefined;
  const queueTrack = state.queue[queueOwner.index];
  const referenceIndex = state.originalQueue.indexOf(queueTrack);
  if (referenceIndex >= 0) {
    return indexedOwner(referenceIndex, state.originalQueue[referenceIndex]);
  }

  let occurrence = 0;
  for (let index = 0; index <= queueOwner.index; index += 1) {
    if (trackMatchesIdentity(state.queue[index], queueOwner)) occurrence += 1;
  }
  for (let index = 0; index < state.originalQueue.length; index += 1) {
    if (!trackMatchesIdentity(state.originalQueue[index], queueOwner)) continue;
    occurrence -= 1;
    if (occurrence === 0) {
      return indexedOwner(index, state.originalQueue[index]);
    }
  }
  return undefined;
}

function captureMatchOwners(
  state: MusicState,
  track: MusicTrack,
  isManual: boolean,
  pagePath?: string
): MatchedTrackOwners | null {
  const identity = trackIdentity(track);
  const activeQueueTrack = state.queue[state.currentIndex];
  const queue = trackMatchesIdentity(activeQueueTrack, identity)
    ? indexedOwner(state.currentIndex, activeQueueTrack)
    : undefined;
  const originalQueue = queue
    ? findOriginalQueueOwner(state, queue)
    : undefined;
  if (queue && state.originalQueue.length > 0 && !originalQueue) return null;

  const wantsFavorite = isManual
    ? pagePath === "/favorites"
    : state.autoMatchFavorites && state.contextId === "favorites";
  let favorite: IndexedTrackOwner | undefined;
  if (wantsFavorite) {
    const index = findActiveTrackIndex(state.favorites, track);
    if (index >= 0) favorite = indexedOwner(index, state.favorites[index]);
  }

  const playlistId = isManual
    ? pagePath?.startsWith("/playlist/")
      ? pagePath.slice("/playlist/".length).split("/")[0]
      : undefined
    : state.autoMatchPlaylists && state.contextId?.startsWith("playlist-")
      ? state.contextId.slice("playlist-".length)
      : undefined;
  let playlist: PlaylistTrackOwner | undefined;
  if (playlistId) {
    const playlistIndex = state.playlists.findIndex(
      (candidate) => candidate.id === playlistId && !candidate.is_deleted
    );
    const ownerPlaylist = state.playlists[playlistIndex];
    const trackIndex = ownerPlaylist
      ? findActiveTrackIndex(ownerPlaylist.tracks, track)
      : -1;
    if (ownerPlaylist && trackIndex >= 0) {
      playlist = {
        playlistId: ownerPlaylist.id,
        playlistIndex,
        trackIndex,
        ...trackIdentity(ownerPlaylist.tracks[trackIndex]),
      };
    }
  }

  // Automatic recovery only owns the active queue slot. Manual replacement
  // may instead own an exact visible collection entry, but never an id match.
  if (!isManual && !queue) return null;
  if (isManual && !queue && !favorite && !playlist) return null;
  return {
    contextEpoch: state.playbackContextEpoch,
    queue,
    originalQueue,
    favorite,
    playlist,
  };
}

function ownersStillMatch(
  state: MusicState,
  owners: MatchedTrackOwners
): boolean {
  if (state.playbackContextEpoch !== owners.contextEpoch) return false;
  if (
    owners.queue &&
    (state.currentIndex !== owners.queue.index ||
      !trackMatchesIdentity(state.queue[owners.queue.index], owners.queue))
  ) {
    return false;
  }
  if (
    owners.originalQueue &&
    !trackMatchesIdentity(
      state.originalQueue[owners.originalQueue.index],
      owners.originalQueue
    )
  ) {
    return false;
  }
  if (
    owners.favorite &&
    (state.favorites[owners.favorite.index]?.is_deleted ||
      !trackMatchesIdentity(
        state.favorites[owners.favorite.index],
        owners.favorite
      ))
  ) {
    return false;
  }
  if (owners.playlist) {
    const playlist = state.playlists[owners.playlist.playlistIndex];
    const playlistTrack = playlist?.tracks[owners.playlist.trackIndex];
    if (
      playlist?.id !== owners.playlist.playlistId ||
      playlistTrack?.is_deleted ||
      !trackMatchesIdentity(playlistTrack, owners.playlist)
    ) {
      return false;
    }
  }
  return true;
}

function generationOwnerKey(owners: MatchedTrackOwners): string {
  if (owners.queue) {
    return JSON.stringify([
      "queue",
      owners.contextEpoch,
      owners.queue.index,
      owners.queue.id,
      owners.queue.source,
      owners.queue.urlId ?? null,
    ]);
  }
  if (owners.playlist) {
    return JSON.stringify([
      "playlist",
      owners.contextEpoch,
      owners.playlist.playlistId,
      owners.playlist.trackIndex,
      owners.playlist.id,
      owners.playlist.source,
      owners.playlist.urlId ?? null,
    ]);
  }
  const favorite = owners.favorite!;
  return JSON.stringify([
    "favorite",
    owners.contextEpoch,
    favorite.index,
    favorite.id,
    favorite.source,
    favorite.urlId ?? null,
  ]);
}

function hasKnownArtists(artists: string[]): boolean {
  const normalized = normalizeArtists(artists);
  return (
    normalized.length > 0 &&
    normalized.every((artist) => !UNKNOWN_ARTIST_NAMES.has(artist))
  );
}

function compareAlbum(
  target: MusicTrack,
  candidate: MusicTrack
): MetadataComparison {
  const left = normalizeIdentityText(target.album);
  const right = normalizeIdentityText(candidate.album);
  if (
    !left ||
    !right ||
    UNKNOWN_ALBUM_NAMES.has(left) ||
    UNKNOWN_ALBUM_NAMES.has(right)
  ) {
    return "unknown";
  }
  return left === right ? "match" : "conflict";
}

function validDuration(duration: number | undefined): duration is number {
  return Number.isFinite(duration) && (duration ?? 0) > 0;
}

function compareDuration(
  target: MusicTrack,
  candidate: MusicTrack
): MetadataComparison {
  if (!validDuration(target.duration) || !validDuration(candidate.duration)) {
    return "unknown";
  }
  const toleranceSeconds = Math.max(5, target.duration * 0.03);
  return Math.abs(target.duration - candidate.duration) <= toleranceSeconds
    ? "match"
    : "conflict";
}

/**
 * Global auto-match safety gate. Explicit version, album and duration conflicts
 * are hard vetoes. Bilibili search results use the uploader as `artist`, so its
 * provider predicate supplies title/artist evidence after this version veto.
 */
export function isAutoMatchIdentityCompatible(
  target: MusicTrack,
  candidate: MusicTrack
): boolean {
  if (!isSameRecordingVersion(target, candidate)) return false;
  if (candidate.source === "bilibili") return true;
  if (!isNameMatch(target.name, candidate.name)) return false;

  const album = compareAlbum(target, candidate);
  const duration = compareDuration(target, candidate);
  if (album === "conflict" || duration === "conflict") return false;

  const targetArtistsKnown = hasKnownArtists(target.artist);
  const candidateArtistsKnown = hasKnownArtists(candidate.artist);
  if (targetArtistsKnown && candidateArtistsKnown) {
    return haveSameArtistSet(target.artist, candidate.artist);
  }

  // With incomplete artist metadata, require an unabridged title match plus one
  // independent known agreement. Missing metadata alone never becomes a match.
  return (
    normalizeIdentityText(target.name) ===
      normalizeIdentityText(candidate.name) &&
    (album === "match" || duration === "match")
  );
}

/**
 * 计算自动换源的单源内排序分数，优先保证歌名与歌手完全一致。
 */
function scoreAutoMatchCandidate(
  target: MusicTrack,
  candidate: MusicTrack,
  originalIndex: number
): number {
  let score = 0;
  const sameArtistSet = haveSameArtistSet(target.artist, candidate.artist);

  if (sameArtistSet) {
    score += 120;
  }

  if (normalizeText(target.name) === normalizeText(candidate.name))
    score += 100;

  // 全量匹配额外加分：保留括号中的版本信息。
  if (
    normalizeIdentityText(target.name) === normalizeIdentityText(candidate.name)
  ) {
    score += 50;
  }

  if (compareAlbum(target, candidate) === "match") score += 50;
  if (compareDuration(target, candidate) === "match") score += 30;

  score += Math.max(0, 20 - originalIndex);

  return score;
}

/**
 * 自动匹配免费源逻辑
 * @param track 需要匹配的歌曲
 * @param targetSource 可选，指定目标音源（仅搜索该音源）
 * @param pagePath 可选，当前页面路径（手动换源时传入，用于判断同步范围）
 * @returns 是否匹配并切换成功
 */
export async function handleAutoMatch(
  track: MusicTrack,
  targetSource?: MusicSource,
  pagePath?: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false;
  if (track.source && EXCLUDED_FOR_SEARCH.includes(track.source)) {
    return false;
  }
  const isManual = targetSource !== undefined;
  const initialState = useMusicStore.getState();
  const owners = captureMatchOwners(initialState, track, isManual, pagePath);
  if (!owners) return false;

  const ownerKey = generationOwnerKey(owners);
  const generation = ++matchRequestGeneration;
  latestMatchGenerationByOwner.set(ownerKey, generation);
  // A real signal is always passed down. Playback/UI callers additionally own
  // its controller, while direct callers are still protected by generation.
  const requestSignal = signal ?? new AbortController().signal;
  const toastId = toast.loading("正在搜索免费音源...", {
    id: `auto-match-${track.id}-${generation}`,
  });
  const requestStillOwnsState = () =>
    !requestSignal.aborted &&
    latestMatchGenerationByOwner.get(ownerKey) === generation &&
    ownersStillMatch(useMusicStore.getState(), owners);

  try {
    if (!requestStillOwnsState()) {
      toast.dismiss(toastId);
      return false;
    }

    const activeTrack = initialState.queue[initialState.currentIndex];
    const existingContext = initialState.autoMatchContext;
    const ctx =
      activeTrack &&
      existingContext?.index === initialState.currentIndex &&
      existingContext.contextEpoch === initialState.playbackContextEpoch &&
      existingContext.trackKey === getTrackIdentityKey(activeTrack)
        ? existingContext
        : {
            index: initialState.currentIndex,
            contextEpoch: initialState.playbackContextEpoch,
            trackKey: activeTrack
              ? getTrackIdentityKey(activeTrack)
              : getTrackIdentityKey(track),
            tried: new Set<MusicSource>(),
          };

    const aggregatedSources: MusicSource[] = isManual
      ? [targetSource!]
      : getAggregatedSourcesForMatch().filter(
          (source) => source !== track.source && !ctx.tried.has(source)
        );

    if (aggregatedSources.length === 0) {
      toast.dismiss(toastId);
      return false;
    }
    const match = await musicApi.searchBestMatch({
      query: `${track.name} ${track.artist[0]}`,
      sources: aggregatedSources,
      predicate: (item: MusicTrack) =>
        isAutoMatchIdentityCompatible(track, item),
      ranker: (item, originalIndex) =>
        scoreAutoMatchCandidate(track, item, originalIndex),
      targetTrack: track,
      signal: requestSignal,
    });

    // A provider may settle after abort. Signal + latest generation + every
    // indexed old-identity owner all have to survive the await.
    if (!requestStillOwnsState()) {
      toast.dismiss(toastId);
      return false;
    }

    if (!match) {
      toast.error("未找到可用音源", { id: toastId });
      return false;
    }

    // 仅对 B 站音源保留原歌曲的 name 和 artist，避免标题杂乱与作者错位
    const latestState = useMusicStore.getState();
    const { bilibiliKeepOriginalMeta } = latestState;
    const finalTrack: MusicTrack =
      match.source === "bilibili" && bilibiliKeepOriginalMeta
        ? { ...match, name: track.name, artist: track.artist }
        : match;

    const nextAutoMatchTried = isManual
      ? undefined
      : (() => {
          const nextTried = new Set(ctx.tried);
          nextTried.add(track.source);
          return nextTried;
        })();

    // 清除目标音源的 URL 缓存，强制重新获取音频 URL
    // 避免复用之前缓存中的试听片段（如 _netease 的 30 秒预览）
    const currentQuality = latestState.quality;
    const newCacheKey = buildUrlCacheKey(
      finalTrack.source,
      finalTrack.id,
      finalTrack.url_id,
      currentQuality
    );
    if (!requestStillOwnsState()) return false;
    const committed = latestState.compareAndSwapMatchedTrack(
      owners,
      finalTrack,
      nextAutoMatchTried
    );
    if (!committed) {
      toast.dismiss(toastId);
      return false;
    }
    useUrlCacheStore.getState().delete(newCacheKey);

    const sourceLabel = sourceLabels[match.source] || match.source;
    toast.success(`已切换至: ${sourceLabel}`, { id: toastId });
    return true;
  } catch (error) {
    if (
      requestSignal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      toast.dismiss(toastId);
      return false;
    }
    logger.error("audio-match", "Auto match failed", error);
    toast.error("自动匹配失败", { id: toastId });
    return false;
  } finally {
    if (latestMatchGenerationByOwner.get(ownerKey) === generation) {
      latestMatchGenerationByOwner.delete(ownerKey);
    }
  }
}
