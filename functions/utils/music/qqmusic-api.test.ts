// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQqMusicUrl, fetchQqPlaylistDetail } from "./qqmusic-api";

afterEach(() => vi.unstubAllGlobals());

describe("QQ Music quality resolution", () => {
  it.each([
    [
      "320k",
      [
        "M800song-midsong-mid.mp3",
        "M500song-midsong-mid.mp3",
        "C400song-midsong-mid.m4a",
      ],
    ],
    ["128k", ["M500song-midsong-mid.mp3", "C400song-midsong-mid.m4a"]],
    ["m4a", ["C400song-midsong-mid.m4a"]],
  ] as const)(
    "starts %s fallback resolution at the requested quality ceiling",
    async (quality, expectedFilenames) => {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          req_1: {
            data: {
              sip: ["https://isure6.stream.qqmusic.qq.com/"],
              midurlinfo: [{ purl: "C400song-midsong-mid.m4a?vkey=canary" }],
            },
          },
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(fetchQqMusicUrl("song-mid", quality)).resolves.toEqual({
        url: expect.stringContaining("vkey=canary"),
      });
      const request = JSON.parse(
        String((fetchMock.mock.calls[0][1] as RequestInit).body)
      ) as {
        req_1: { param: { filename: string[] } };
      };

      expect(request.req_1.param.filename).toEqual(expectedFilenames);
    }
  );
});

describe("QQ Music playlist persistence boundary", () => {
  it("normalizes a real HTTP/query logo before returning the detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 0,
            cdlist: [
              {
                dissname: "QQ playlist",
                logo: "http://y.gtimg.cn/cover.jpg?max_age=2592000#display",
                songnum: 0,
                songlist: [],
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(fetchQqPlaylistDetail("123456")).resolves.toMatchObject({
      name: "QQ playlist",
      coverUrl: "https://y.gtimg.cn/cover.jpg",
    });
  });
});
