import { describe, expect, it } from "vitest";
import { MusicProviderFactory } from "./factory";
import type { MusicTrack } from "@/types/music";

const qqTrack: MusicTrack = {
  id: "qq_000abc",
  name: "QQ测试歌曲",
  artist: ["QQ测试歌手"],
  album: "QQ测试专辑",
  pic_id: "https://y.gtimg.cn/music/photo_new/T002R800x800M000abc.jpg",
  url_id: "",
  lyric_id: "",
  source: "qq",
};

const kugouTrack: MusicTrack = {
  id: "kugou_ABC",
  name: "测试歌曲",
  artist: ["测试歌手"],
  album: "测试专辑",
  pic_id: "https://example.com/cover.jpg",
  url_id: "ABC",
  lyric_id: "",
  source: "kugou",
};

const miguTrack: MusicTrack = {
  id: "migu_60054704083_600908000006663347",
  name: "测试歌曲",
  artist: ["测试歌手"],
  album: "测试专辑",
  pic_id: "https://example.com/migu-cover.jpg",
  url_id: "migu_60054704083_600908000006663347",
  lyric_id: "",
  source: "migu",
};

const bilibiliTrack: MusicTrack = {
  id: "bilibili_BV1xx411c7mD",
  name: "Bilibili Song",
  artist: ["UP"],
  album: "Bilibili",
  pic_id: "https://example.com/bilibili-cover.jpg",
  url_id: "bilibili_BV1xx411c7mD",
  lyric_id: "",
  source: "bilibili",
};

const urlTrack: MusicTrack = {
  id: "url_https-example-com-music-test-mp3",
  name: "Direct URL",
  artist: ["User"],
  album: "",
  pic_id: "https://example.com/cover.jpg",
  url_id: "https://example.com/music/test.mp3",
  lyric_id: "",
  source: "url",
};

describe("MusicProviderFactory", () => {
  it("creates a safe placeholder provider for Kugou tracks", async () => {
    const provider = MusicProviderFactory.getProvider("kugou");

    await expect(provider.search("测试", 1, 20)).resolves.toEqual({
      items: [],
      hasMore: false,
    });
    await expect(provider.getUrl(kugouTrack)).resolves.toBeNull();
    await expect(provider.getPic(kugouTrack)).resolves.toBe(
      "https://example.com/cover.jpg"
    );
    await expect(provider.getLyric(kugouTrack)).resolves.toBeNull();
  });

  it("creates a provider for Migu tracks", async () => {
    const provider = MusicProviderFactory.getProvider("migu");
    expect(provider.source).toBe("migu");
    await expect(provider.getPic(miguTrack)).resolves.toBe(
      "https://example.com/migu-cover.jpg"
    );
    await expect(provider.getLyric(miguTrack)).resolves.toBeNull();
  });

  it("creates a provider for Bilibili tracks", async () => {
    const provider = MusicProviderFactory.getProvider("bilibili");

    await expect(provider.getPic(bilibiliTrack)).resolves.toMatch(
      /\/music-api\/bilibili\/cover\?url=https%3A%2F%2Fexample\.com%2Fbilibili-cover\.jpg$/
    );
    await expect(provider.getLyric(bilibiliTrack)).resolves.toBeNull();
  });

  it("creates a provider for QQ tracks", async () => {
    const provider = MusicProviderFactory.getProvider("qq");
    expect(provider.source).toBe("qq");
    await expect(provider.getPic(qqTrack)).resolves.toBe(
      "https://y.gtimg.cn/music/photo_new/T002R800x800M000abc.jpg"
    );
    await expect(provider.getLyric(qqTrack)).resolves.toBeNull();
  });

  it("creates a provider for user-supplied media URLs", async () => {
    const provider = MusicProviderFactory.getProvider("url");
    expect(provider.source).toBe("url");
    await expect(provider.search("测试", 1, 20)).resolves.toEqual({
      items: [],
      hasMore: false,
    });
    await expect(provider.getUrl(urlTrack)).resolves.toBe(
      "https://example.com/music/test.mp3"
    );
    await expect(provider.getPic(urlTrack)).resolves.toBe(
      "https://example.com/cover.jpg"
    );
    await expect(provider.getLyric(urlTrack)).resolves.toBeNull();
  });
});
