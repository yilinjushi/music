import { describe, expect, it } from "vitest";
import { convertSongToMusicTrack } from "./netease-api";
import { sanitizeTrackForPersistence } from "@/lib/utils/sensitive-data";

describe("convertSongToMusicTrack duration", () => {
  it("converts the documented NetEase millisecond duration to seconds", () => {
    const track = convertSongToMusicTrack({
      id: 1,
      name: "爱错",
      ar: [{ id: 2, name: "王力宏" }],
      al: { id: 3, name: "心中的日月" },
      dt: 246_000,
    });

    expect(track.duration).toBe(246);
  });

  it("leaves a missing or invalid duration unknown", () => {
    expect(convertSongToMusicTrack({ id: 1 }).duration).toBeUndefined();
    expect(convertSongToMusicTrack({ id: 1, dt: 0 }).duration).toBeUndefined();
  });

  it("normalizes a real NetEase artwork URL before queue persistence", () => {
    const track = convertSongToMusicTrack({
      id: 1,
      name: "Song",
      ar: [{ id: 2, name: "Artist" }],
      al: {
        id: 3,
        name: "Album",
        picUrl: "http://p1.music.126.net/cover.jpg?param=300y300",
      },
    });

    expect(track.pic_id).toBe("https://p1.music.126.net/cover.jpg");
    expect(sanitizeTrackForPersistence(track)).toEqual(track);
  });
});
