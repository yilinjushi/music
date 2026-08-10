import { describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "@/types/music";
import { isAutoMatchIdentityCompatible } from "@/lib/audio-match";
import { createAutoMatchPredicate } from "./bilibili-match";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("react-hot-toast", () => ({
  toast: {
    loading: vi.fn(() => "toast-id"),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function createTrack(
  id: string,
  source: MusicTrack["source"],
  name: string,
  artist: string[],
  album = ""
): MusicTrack {
  return {
    id,
    source,
    name,
    artist,
    album,
    pic_id: `pic-${id}`,
    url_id: `url-${id}`,
    lyric_id: `lyric-${id}`,
  };
}

function passesBilibiliAutoMatch(
  target: MusicTrack,
  candidate: MusicTrack
): boolean {
  return (
    isAutoMatchIdentityCompatible(target, candidate) &&
    createAutoMatchPredicate(target)(candidate)
  );
}

describe("createAutoMatchPredicate", () => {
  it("rejects a Shallow solo upload and accepts the complete reordered duet", () => {
    const target = createTrack(
      "target",
      "_netease",
      "Shallow",
      ["Lady Gaga", "Bradley Cooper"],
      "A Star Is Born"
    );
    const wrongSolo = createTrack(
      "solo",
      "bilibili",
      "Lady Gaga - Shallow (Official Audio)",
      ["Lady Gaga Official"]
    );
    const correctDuet = createTrack(
      "duet",
      "bilibili",
      "Bradley Cooper & Lady Gaga - Shallow",
      ["电影原声频道"]
    );

    expect(passesBilibiliAutoMatch(target, wrongSolo)).toBe(false);
    expect(passesBilibiliAutoMatch(target, correctDuet)).toBe(true);
  });

  it("requires every artist for a Chinese multi-artist target", () => {
    const target = createTrack("target", "_netease", "珊瑚海", [
      "周杰伦",
      "梁心颐",
    ]);
    const missingArtist = createTrack(
      "missing",
      "bilibili",
      "周杰伦 - 珊瑚海",
      ["周杰伦音乐站"]
    );
    const completeReordered = createTrack(
      "complete",
      "bilibili",
      "梁心颐 / 周杰伦 - 珊瑚海",
      ["华语音乐"]
    );

    expect(createAutoMatchPredicate(target)(missingArtist)).toBe(false);
    expect(createAutoMatchPredicate(target)(completeReordered)).toBe(true);
  });

  it("does not use a short substring inside another artist as evidence", () => {
    const target = createTrack("target", "_netease", "Song", ["Li"]);
    const falsePositive = createTrack(
      "candidate",
      "bilibili",
      "Song - Billie Eilish",
      ["Billie Eilish"]
    );

    expect(createAutoMatchPredicate(target)(falsePositive)).toBe(false);
  });

  it("preserves exact single-artist matching across title and uploader tokens", () => {
    const target = createTrack("target", "_netease", "Poker Face", [
      "Lady Gaga",
    ]);
    const candidate = createTrack(
      "candidate",
      "bilibili",
      "Poker Face (Official Audio)",
      ["Lady Gaga Official"]
    );

    expect(createAutoMatchPredicate(target)(candidate)).toBe(true);
  });

  it("rejects a numbered sequel even with the same artist and official-audio metadata", () => {
    const target = createTrack("target", "_netease", "Song", ["Artist"]);
    const wrongSequel = createTrack(
      "candidate",
      "bilibili",
      "Artist - Song 2 (Official Audio)",
      ["Artist Official"]
    );

    expect(createAutoMatchPredicate(target)(wrongSequel)).toBe(false);
    expect(passesBilibiliAutoMatch(target, wrongSequel)).toBe(false);
  });

  it("rejects a longer title that merely contains the complete target token", () => {
    const target = createTrack("target", "_netease", "Song", ["Artist"]);
    const prefixedTitle = createTrack(
      "prefixed",
      "bilibili",
      "Artist - My Song (Official Audio)",
      ["Artist Official"]
    );
    const suffixedTitle = createTrack(
      "suffixed",
      "bilibili",
      "Artist - Song Again (Official Audio)",
      ["Artist Official"]
    );

    expect(createAutoMatchPredicate(target)(prefixedTitle)).toBe(false);
    expect(createAutoMatchPredicate(target)(suffixedTitle)).toBe(false);
  });

  it("preserves identity-bearing parenthetical title content", () => {
    const target = createTrack(
      "target",
      "_netease",
      "Sweet Dreams (Are Made of This)",
      ["Eurythmics"]
    );
    const complete = createTrack(
      "complete",
      "bilibili",
      "Eurythmics - Sweet Dreams (Are Made of This) (Official Video)",
      ["Eurythmics Official"]
    );
    const truncated = createTrack(
      "truncated",
      "bilibili",
      "Eurythmics - Sweet Dreams (Official Video)",
      ["Eurythmics Official"]
    );

    expect(createAutoMatchPredicate(target)(complete)).toBe(true);
    expect(createAutoMatchPredicate(target)(truncated)).toBe(false);
  });

  it.each(["Part II", "Reprise"])(
    "treats %s as song identity rather than disposable video metadata",
    (identitySuffix) => {
      const target = createTrack(
        "target",
        "_netease",
        `Song (${identitySuffix})`,
        ["Artist"]
      );
      const exact = createTrack(
        "exact",
        "bilibili",
        `Artist - Song ${identitySuffix} (Official Audio)`,
        ["Artist Official"]
      );
      const baseSong = createTrack(
        "base",
        "bilibili",
        "Artist - Song (Official Audio)",
        ["Artist Official"]
      );

      expect(passesBilibiliAutoMatch(target, exact)).toBe(true);
      expect(passesBilibiliAutoMatch(target, baseSong)).toBe(false);
    }
  );

  it("keeps Live and Remix annotations governed by the recording-version veto", () => {
    const live2023 = createTrack(
      "live-target",
      "_netease",
      "Song (Live 2023)",
      ["Artist"]
    );
    const sameLive = createTrack(
      "same-live",
      "bilibili",
      "Artist - Song Live 2023 (Official Video)",
      ["Artist Official"]
    );
    const wrongLiveYear = createTrack(
      "wrong-live",
      "bilibili",
      "Artist - Song Live 2024 (Official Video)",
      ["Artist Official"]
    );
    const remix = createTrack("remix-target", "_netease", "Song (Remix)", [
      "Artist",
    ]);
    const sameRemix = createTrack(
      "same-remix",
      "bilibili",
      "Artist - Song Remix (Official Audio)",
      ["Artist Official"]
    );
    const studio = createTrack(
      "studio",
      "bilibili",
      "Artist - Song (Official Audio)",
      ["Artist Official"]
    );

    expect(passesBilibiliAutoMatch(live2023, sameLive)).toBe(true);
    expect(passesBilibiliAutoMatch(live2023, wrongLiveYear)).toBe(false);
    expect(passesBilibiliAutoMatch(remix, sameRemix)).toBe(true);
    expect(passesBilibiliAutoMatch(remix, studio)).toBe(false);
  });

  it("allows only explained artist, album, and video-metadata tokens around the title", () => {
    const target = createTrack(
      "target",
      "_netease",
      "Poker Face",
      ["Lady Gaga"],
      "The Fame"
    );
    const candidate = createTrack(
      "candidate",
      "bilibili",
      "Lady Gaga - Poker Face - The Fame (Official Music Video 1080p)",
      ["Lady Gaga Official"]
    );

    expect(createAutoMatchPredicate(target)(candidate)).toBe(true);
  });

  it("requires the song name in the video title rather than unrelated metadata", () => {
    const target = createTrack("target", "_netease", "Shallow", [
      "Lady Gaga",
      "Bradley Cooper",
    ]);
    const candidate = createTrack(
      "candidate",
      "bilibili",
      "Unrelated interview",
      ["Lady Gaga", "Bradley Cooper"],
      "Shallow"
    );

    expect(createAutoMatchPredicate(target)(candidate)).toBe(false);
  });

  it("keeps explicit recording-version mismatches behind the global veto", () => {
    const target = createTrack("target", "_netease", "爱错", ["王力宏"]);
    const wrongLive = createTrack(
      "live",
      "bilibili",
      "王力宏 - 爱错 Live 2024",
      ["华语现场"]
    );

    // The provider has enough title/artist evidence, but the global identity
    // gate must veto the explicit live/studio mismatch before it is admitted.
    expect(createAutoMatchPredicate(target)(wrongLive)).toBe(true);
    expect(isAutoMatchIdentityCompatible(target, wrongLive)).toBe(false);
    expect(passesBilibiliAutoMatch(target, wrongLive)).toBe(false);
  });

  it("fails closed when target artist metadata is absent or unknown", () => {
    const candidate = createTrack("candidate", "bilibili", "Artist - Song", [
      "Artist",
    ]);

    expect(
      createAutoMatchPredicate(createTrack("missing", "_netease", "Song", []))(
        candidate
      )
    ).toBe(false);
    expect(
      createAutoMatchPredicate(
        createTrack("unknown", "_netease", "Song", ["Unknown Artist"])
      )(candidate)
    ).toBe(false);
  });
});
