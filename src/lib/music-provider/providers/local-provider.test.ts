import { describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "@/types/music";
import { LocalProvider } from "./local-provider";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

const makeTrack = (url: string): MusicTrack => ({
  id: "local-1",
  name: "Song",
  artist: ["Artist"],
  album: "Album",
  pic_id: url,
  url_id: url,
  lyric_id: url,
  source: "local",
});

describe("LocalProvider browser behavior", () => {
  it("plays a browser-owned blob URL", async () => {
    await expect(
      new LocalProvider().getUrl(makeTrack("blob:track"))
    ).resolves.toBe("blob:track");
  });

  it("gracefully rejects a historical device path", async () => {
    const provider = new LocalProvider();
    const track = makeTrack("/storage/emulated/0/Music/song.mp3");
    await expect(provider.getUrl(track)).resolves.toBeNull();
    await expect(provider.getPic(track)).resolves.toBeNull();
    await expect(provider.getLyric(track)).resolves.toBeNull();
  });
});
