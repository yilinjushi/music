import { describe, expect, it } from "vitest";
import {
  buildCanonicalTrackShareText,
  getCanonicalShareUrl,
} from "./share-url";
import type { MusicTrack } from "@/types/music";

function track(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: "test-id",
    name: "Test Song",
    artist: ["Test Artist"],
    album: "Test Album",
    pic_id: "",
    url_id: "test-id",
    lyric_id: "",
    source: "netease",
    ...overrides,
  };
}

describe("getCanonicalShareUrl", () => {
  it("generates bilibili video URL", () => {
    const url = getCanonicalShareUrl(
      track({ id: "bilibili_BV1xx411c7mD", source: "bilibili" })
    );
    expect(url).toBe("https://www.bilibili.com/video/BV1xx411c7mD");
  });

  it("handles bilibili id without prefix", () => {
    const url = getCanonicalShareUrl(
      track({ id: "BV1xx411c7mD", source: "bilibili" })
    );
    expect(url).toBe("https://www.bilibili.com/video/BV1xx411c7mD");
  });

  it("strips trailing _cid from bilibili id", () => {
    const url = getCanonicalShareUrl(
      track({ id: "bilibili_BV1fx411N7bU_2164311", source: "bilibili" })
    );
    expect(url).toBe("https://www.bilibili.com/video/BV1fx411N7bU");
  });

  it("strips trailing _cid from bilibili id without prefix", () => {
    const url = getCanonicalShareUrl(
      track({ id: "BV1fx411N7bU_2164311", source: "bilibili" })
    );
    expect(url).toBe("https://www.bilibili.com/video/BV1fx411N7bU");
  });

  it("returns null for non-bilibili sources", () => {
    expect(getCanonicalShareUrl(track({ source: "netease" }))).toBeNull();
    expect(getCanonicalShareUrl(track({ source: "_netease" }))).toBeNull();
    expect(getCanonicalShareUrl(track({ source: "kuwo" }))).toBeNull();
    expect(getCanonicalShareUrl(track({ source: "migu" }))).toBeNull();
    expect(getCanonicalShareUrl(track({ source: "joox" }))).toBeNull();
    expect(getCanonicalShareUrl(track({ source: "local" }))).toBeNull();
    expect(getCanonicalShareUrl(track({ source: "url" }))).toBeNull();
  });

  it("rejects malformed bilibili ids instead of constructing a fake canonical url", () => {
    expect(
      getCanonicalShareUrl(
        track({ source: "bilibili", id: "bilibili_not-a-bvid" })
      )
    ).toBeNull();
  });

  it("never turns a resolved or persisted media capability into share text", () => {
    expect(
      buildCanonicalTrackShareText(
        track({
          source: "qq",
          url_id: "https://stream.qqmusic.qq.com/a.m4a?vkey=private-canary",
        })
      )
    ).toBeNull();
    expect(
      buildCanonicalTrackShareText(
        track({
          source: "bilibili",
          id: "bilibili_BV1xx411c7mD",
          url_id: "/music-api/bilibili/audio?bvid=BV1xx411c7mD",
        })
      )
    ).toBe(
      "【OtterMusic】Test Song - Test Artist\nhttps://www.bilibili.com/video/BV1xx411c7mD"
    );
  });
});
