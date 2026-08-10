import { describe, expect, it, vi } from "vitest";
import { importPlaylist } from "./playlist-backup";

vi.mock("@/lib/utils/toast", () => ({
  toastUtils: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const baseTrack = {
  id: "1",
  name: "Song",
  artist: ["Artist"],
  album: "Album",
  pic_id: "cover",
  url_id: "https://media.example/song.mp3",
  lyric_id: "lyric",
  source: "url",
};

describe("playlist backup ingress", () => {
  it("rejects a double-encoded sensitive field instead of partially importing", async () => {
    const file = new File(
      [
        JSON.stringify({
          name: "Imported",
          tracks: [
            baseTrack,
            { ...baseTrack, id: "2", extra: "Cookie%253DMUSIC_U-canary" },
          ],
        }),
      ],
      "playlist.json",
      { type: "application/json" }
    );

    await expect(importPlaylist(file)).rejects.toThrow(/敏感/);
  });

  it("rejects oversized files before reading or parsing them", async () => {
    const file = new File(
      [new Uint8Array(8 * 1024 * 1024 + 1)],
      "oversized.json",
      { type: "application/json" }
    );

    await expect(importPlaylist(file)).rejects.toThrow(/文件过大/);
  });

  it("rejects a mixed malformed backup instead of partially importing it", async () => {
    const file = new File(
      [
        JSON.stringify({
          name: "Atomic import",
          tracks: [baseTrack, { name: "Missing identity" }],
        }),
      ],
      "atomic.json",
      { type: "application/json" }
    );

    await expect(importPlaylist(file)).rejects.toThrow(/歌曲数据格式/);
  });
});
