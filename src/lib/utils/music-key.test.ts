import { describe, expect, it } from "vitest";
import type { MusicTrack } from "@/types/music";
import {
  extractRecordingVersionTraits,
  haveSameArtistSet,
  isSameRecordingVersion,
} from "./music-key";

const track = (
  name: string,
  artist: string[] = ["王力宏"],
  album = "心中的日月"
): MusicTrack => ({
  id: name,
  name,
  artist,
  album,
  pic_id: "",
  url_id: name,
  lyric_id: name,
  source: "joox",
});

describe("recording version identity", () => {
  it.each([
    "愛錯 (Live)",
    "愛錯（伴唱版）",
    "愛錯 - 翻唱",
    "愛錯 (纯音乐)",
    "愛錯 [Remix]",
    "愛錯 (Acoustic)",
  ])("rejects an explicit %s variant for a studio target", (candidateName) => {
    expect(isSameRecordingVersion(track("爱错"), track(candidateName))).toBe(
      false
    );
  });

  it("treats equivalent live labels as the same version", () => {
    expect(
      isSameRecordingVersion(track("爱错 (Live)"), track("愛錯（现场版）"))
    ).toBe(true);
  });

  it("rejects live recordings with conflicting explicit years", () => {
    expect(
      isSameRecordingVersion(
        track("爱错 (Live 2023)"),
        track("愛錯（Live 2024）")
      )
    ).toBe(false);
  });

  it("does not treat an unknown parenthetical translation as a version", () => {
    expect(
      isSameRecordingVersion(
        track("告白气球"),
        track("告白氣球 (Love Confession)")
      )
    ).toBe(true);
  });

  it("allows equivalent collaboration metadata when both full artist sets agree", () => {
    expect(
      isSameRecordingVersion(
        track("不该 (feat. aMEI)", ["周杰伦", "张惠妹"]),
        track("不該", ["張惠妹", "周杰倫"])
      )
    ).toBe(true);
  });

  it("extracts version tags before punctuation and brackets are removed", () => {
    expect(
      extractRecordingVersionTraits("愛錯 (feat. 單依純) (Live)").tags
    ).toEqual(["collaboration", "live"]);
  });
});

describe("complete artist identity", () => {
  it("splits combined artist fields and compares the complete set", () => {
    expect(haveSameArtistSet(["王力宏、单依纯"], ["單依純", "王力宏"])).toBe(
      true
    );
    expect(haveSameArtistSet(["A feat. B"], ["B", "A"])).toBe(true);
  });

  it("does not accept a solo artist merely because a duet shares that artist", () => {
    expect(haveSameArtistSet(["王力宏"], ["王力宏", "单依纯"])).toBe(false);
  });
});
