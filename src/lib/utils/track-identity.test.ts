import { describe, expect, it } from "vitest";
import type { MusicTrack } from "@/types/music";
import {
  findTrackIdentityIndex,
  getTrackIdentityKey,
  getTrackOccurrenceKeys,
  isSameTrackIdentity,
  normalizeTrackUrlId,
  removeOneTrackIdentity,
} from "./track-identity";

function track(
  id: string,
  source: MusicTrack["source"],
  urlId = id
): MusicTrack {
  return {
    id,
    source,
    url_id: urlId,
    name: id,
    artist: ["Artist"],
    album: "Album",
    pic_id: "",
    lyric_id: "",
  };
}

describe("track identity", () => {
  it("distinguishes equal provider ids across source and url_id", () => {
    const netease = track("1", "netease", "url-a");
    const official = track("1", "_netease", "url-a");
    const alternate = track("1", "netease", "url-b");

    expect(getTrackIdentityKey(netease)).not.toBe(
      getTrackIdentityKey(official)
    );
    expect(getTrackIdentityKey(netease)).not.toBe(
      getTrackIdentityKey(alternate)
    );
    expect(isSameTrackIdentity(netease, { ...netease })).toBe(true);
    expect(isSameTrackIdentity(netease, official)).toBe(false);
  });

  it("canonicalizes a missing legacy url_id to the empty identity", () => {
    const legacy = { id: "1", source: "netease" as const };
    const normalized = track("1", "netease", "");

    expect(normalizeTrackUrlId(undefined)).toBe("");
    expect(getTrackIdentityKey(legacy)).toBe(getTrackIdentityKey(normalized));
    expect(isSameTrackIdentity(legacy, normalized)).toBe(true);
  });

  it("prefers an exact occurrence and removes only that row", () => {
    const first = track("1", "netease");
    const second = { ...first };
    const otherSource = track("1", "_netease");
    const tracks = [first, second, otherSource];

    expect(findTrackIdentityIndex(tracks, second)).toBe(1);
    expect(removeOneTrackIdentity(tracks, second)).toEqual([
      first,
      otherSource,
    ]);
    const occurrenceKeys = getTrackOccurrenceKeys(tracks);
    expect(new Set(occurrenceKeys)).toHaveLength(3);
    expect(occurrenceKeys[0]).not.toBe(occurrenceKeys[1]);
  });
});
