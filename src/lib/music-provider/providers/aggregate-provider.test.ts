import { describe, expect, it, vi } from "vitest";
import type { IMusicProvider } from "../interface";
import type { MusicSource, MusicTrack } from "@/types/music";
import { AggregateProvider } from "./aggregate-provider";

function track(id: string, source: MusicSource): MusicTrack {
  return {
    id,
    name: `Track ${id}`,
    artist: ["Artist"],
    album: "Album",
    pic_id: "",
    url_id: id,
    lyric_id: id,
    source,
  };
}

function provider(
  source: MusicSource,
  search: IMusicProvider["search"]
): IMusicProvider {
  return {
    source,
    search,
    getUrl: vi.fn(),
    getPic: vi.fn(),
    getLyric: vi.fn(),
  };
}

describe("AggregateProvider", () => {
  it("keeps results from healthy sources when another search rejects asynchronously", async () => {
    const providers = new Map<MusicSource, IMusicProvider>([
      [
        "joox",
        provider("joox", vi.fn().mockRejectedValue(new Error("offline"))),
      ],
      [
        "kuwo",
        provider(
          "kuwo",
          vi.fn().mockResolvedValue({
            items: [track("healthy", "kuwo")],
            hasMore: true,
          })
        ),
      ],
    ]);
    const aggregate = new AggregateProvider(
      (source) => providers.get(source)!,
      () => ["joox", "kuwo"]
    );

    await expect(aggregate.search("Track", 1, 20)).resolves.toMatchObject({
      items: [{ id: "healthy", source: "kuwo" }],
      hasMore: true,
    });
  });

  it("propagates AbortError instead of converting cancellation into an empty source", async () => {
    const aborted = new DOMException("Aborted", "AbortError");
    const aggregate = new AggregateProvider(
      () => provider("joox", vi.fn().mockRejectedValue(aborted)),
      () => ["joox"]
    );

    await expect(aggregate.search("Track", 1, 20)).rejects.toBe(aborted);
  });
});
