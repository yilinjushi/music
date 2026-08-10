import { describe, expect, it } from "vitest";
import { buildGenericAudioPath, normalizeTrack } from "./utils";
import { normalizeAudioUrlForPlayback } from "@/lib/utils/audio-url";
import { sanitizeTrackForPersistence } from "@/lib/utils/sensitive-data";

const rawTrack = {
  id: "track-id",
  name: "爱错",
  artist: ["王力宏"],
  album: "心中的日月",
  pic_id: "",
  url_id: "track-id",
  lyric_id: "track-id",
};

describe("normalizeTrack duration", () => {
  it("preserves the common API duration in seconds", () => {
    expect(
      normalizeTrack({ ...rawTrack, duration: 246 }, "joox").duration
    ).toBe(246);
  });

  it("treats missing and non-positive duration as unknown", () => {
    expect(normalizeTrack(rawTrack, "joox").duration).toBeUndefined();
    expect(
      normalizeTrack({ ...rawTrack, duration: 0 }, "joox").duration
    ).toBeUndefined();
  });

  it("normalizes URL resources while keeping provider URL identity opaque", () => {
    const track = normalizeTrack(
      {
        ...rawTrack,
        id: "123",
        pic_id: "http://cdn.example/cover.jpg?size=300#preview",
        lyric_id: "//cdn.example/lyric.lrc?display=1",
        url_id: "https://cdn.example/audio.mp3?vkey=must-not-persist",
      },
      "netease"
    );

    expect(track).toMatchObject({
      pic_id: "https://cdn.example/cover.jpg",
      lyric_id: "https://cdn.example/lyric.lrc",
      url_id: "123",
    });
    expect(sanitizeTrackForPersistence(track)).toEqual(track);
  });

  it("degrades nullable resource fields without persisting a capability url_id", () => {
    const track = normalizeTrack(
      {
        ...rawTrack,
        id: "123",
        pic_id: null,
        lyric_id: undefined,
        url_id: "https://cdn.example/audio.mp3?token=must-not-persist",
      } as unknown as Parameters<typeof normalizeTrack>[0],
      "netease"
    );

    expect(track).toMatchObject({
      pic_id: "",
      lyric_id: "",
      url_id: "123",
    });
    expect(sanitizeTrackForPersistence(track)).toEqual(track);
  });

  it("keeps an invalid fallback identifier outside the persistence boundary", () => {
    const track = normalizeTrack(
      {
        ...rawTrack,
        id: "https://cdn.example/audio.mp3?opaque=capability",
        pic_id: undefined,
        lyric_id: null,
        url_id: null,
      } as unknown as Parameters<typeof normalizeTrack>[0],
      "netease"
    );

    expect(track.pic_id).toBe("");
    expect(track.lyric_id).toBe("");
    expect(track.url_id).toBe("");
    expect(sanitizeTrackForPersistence(track)).toBeNull();
  });
});

describe("generic provider opaque audio paths", () => {
  it.each([
    { source: "netease" as const, id: "123" },
    { source: "joox" as const, id: "ab+/cd==" },
    { source: "kuwo" as const, id: "MUSIC_123" },
  ])("constructs a normalizer-safe path for $source", ({ source, id }) => {
    const url = buildGenericAudioPath(source, id, 999);
    expect(url).toBe(
      `/music-api/audio?${new URLSearchParams({
        source,
        id,
        br: "999",
      }).toString()}`
    );
    expect(url).not.toMatch(/vkey|deadline|signature/i);
    expect(normalizeAudioUrlForPlayback(url || "")).toBe(url);
  });

  it("fails closed for an unsupported source or unsafe id", () => {
    expect(buildGenericAudioPath("spotify", "dHJhY2sx", 320)).toBeNull();
    expect(buildGenericAudioPath("joox", "../track", 320)).toBeNull();
  });

  it("accepts both observed Joox Base64 alphabets", () => {
    expect(
      buildGenericAudioPath("joox", "kCN0Rxo1tdbc0+iNxoyBIg==", 320)
    ).not.toBeNull();
    expect(
      buildGenericAudioPath("joox", "nBx_njFDSXCkc4u6aeoOOA==", 320)
    ).not.toBeNull();
  });
});
