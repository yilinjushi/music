import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchKugouPlaylistPages,
  KUGOU_MAX_PLAYLIST_PAGES,
  KUGOU_MAX_PLAYLIST_TRACKS,
} from "./kugou";
import { fetchKuwoPlaylistDetail, KUWO_MAX_PLAYLIST_TRACKS } from "./kuwo";
import {
  fetchMiguPlaylistDetail,
  MIGU_MAX_PLAYLIST_TRACKS,
  MIGU_PLAYLIST_WALL_CLOCK_MS,
} from "./migu";

const songs = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    copyrightId: `copyright-${index}`,
    contentId: `content-${index}`,
    songName: `Song ${index}`,
  }));

afterEach(() => {
  vi.useRealTimers();
});

describe("public playlist pagination budgets", () => {
  it("imports a multi-page Migu playlist within the fixed cap", async () => {
    const fetchText = vi.fn(async (path: string) => {
      if (path.includes("resourceinfo")) {
        return JSON.stringify({
          code: "000000",
          resource: [{ title: "bounded", musicNum: 125 }],
        });
      }
      const page = Number(
        new URL(`https://migu.invalid${path}`).searchParams.get("pageNo")
      );
      const count = page < 3 ? 50 : 25;
      return JSON.stringify({
        code: "000000",
        totalCount: 125,
        list: songs(count),
      });
    });

    const detail = await fetchMiguPlaylistDetail("123", fetchText);

    expect(detail.songs).toHaveLength(125);
    expect(fetchText).toHaveBeenCalledTimes(4);
  });

  it("rejects an advertised Migu total before paging past the cap", async () => {
    const fetchText = vi.fn().mockResolvedValue(
      JSON.stringify({
        code: "000000",
        resource: [{ musicNum: MIGU_MAX_PLAYLIST_TRACKS + 1 }],
      })
    );

    await expect(fetchMiguPlaylistDetail("123", fetchText)).rejects.toThrow(
      /safe track limit/
    );
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it("stops Migu pagination when the shared wall-clock budget expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fetchText = vi.fn(async () => {
      vi.setSystemTime(new Date(Date.now() + MIGU_PLAYLIST_WALL_CLOCK_MS));
      return JSON.stringify({
        code: "000000",
        resource: [{ musicNum: 1 }],
      });
    });

    await expect(fetchMiguPlaylistDetail("123", fetchText)).rejects.toThrow(
      /time budget/
    );
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it("imports Kugou pages but rejects totals above 500", async () => {
    const fetchText = vi.fn(async (path: string) => {
      const page = Number(
        new URL(`https://kugou.invalid${path}`).searchParams.get("page")
      );
      return JSON.stringify({
        status: 1,
        errcode: 0,
        data: {
          total: 250,
          info: Array.from({ length: page < 3 ? 100 : 50 }, (_, index) => ({
            hash: `${page}-${index}`,
          })),
        },
      });
    });

    const detail = await fetchKugouPlaylistPages("123", fetchText);
    expect(detail).toMatchObject({ trackCount: 250 });
    expect(detail.songs).toHaveLength(250);
    expect(fetchText).toHaveBeenCalledTimes(3);

    const oversized = vi.fn().mockResolvedValue(
      JSON.stringify({
        status: 1,
        errcode: 0,
        data: { total: KUGOU_MAX_PLAYLIST_TRACKS + 1, info: [{ hash: "1" }] },
      })
    );
    await expect(fetchKugouPlaylistPages("123", oversized)).rejects.toThrow(
      /safe track limit/
    );
    expect(oversized).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Kugou still advertises continuation at the page cap", async () => {
    const fetchText = vi.fn().mockResolvedValue(
      JSON.stringify({
        status: 1,
        errcode: 0,
        data: {
          info: Array.from({ length: 100 }, (_, index) => ({
            hash: String(index),
          })),
        },
      })
    );

    await expect(fetchKugouPlaylistPages("123", fetchText)).rejects.toThrow(
      /page budget/
    );
    expect(fetchText).toHaveBeenCalledTimes(KUGOU_MAX_PLAYLIST_PAGES);
  });

  it("uses 100-song Kuwo pages and rejects oversized totals", async () => {
    const fetchText = vi.fn(async (path: string) => {
      const page = Number(
        new URL(`https://kuwo.invalid${path}`).searchParams.get("pn")
      );
      return JSON.stringify({
        result: "ok",
        total: 250,
        musiclist: Array.from({ length: page < 2 ? 100 : 50 }, (_, index) => ({
          rid: `${page}-${index}`,
        })),
      });
    });

    const detail = await fetchKuwoPlaylistDetail("123", fetchText);
    expect(detail.songs).toHaveLength(250);
    expect(fetchText).toHaveBeenCalledTimes(3);
    for (const [path] of fetchText.mock.calls) {
      expect(path).toContain("rn=100");
    }

    const oversized = vi.fn().mockResolvedValue(
      JSON.stringify({
        result: "ok",
        total: KUWO_MAX_PLAYLIST_TRACKS + 1,
        musiclist: [{ rid: "1" }],
      })
    );
    await expect(fetchKuwoPlaylistDetail("123", oversized)).rejects.toThrow(
      /safe track limit/
    );
    expect(oversized).toHaveBeenCalledTimes(1);
  });
});
