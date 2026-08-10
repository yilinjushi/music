import { beforeEach, describe, expect, it, vi } from "vitest";
import { musicApi } from "./music-api";

describe("musicApi same-origin route", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("ignores a legacy cross-origin fallback stored by older releases", async () => {
    localStorage.setItem(
      "otter_music_api_urls",
      JSON.stringify([
        "https://primary.test/api.php",
        "https://backup.test/api.php?api_token=canary",
      ])
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "1",
            name: "song",
            artist: "artist",
            album: "album",
            pic_id: "https://img.test/a.jpg",
            url_id: "https://audio.test/a.mp3",
            lyric_id: "https://lyric.test/a.lrc",
          },
        ]),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await musicApi.search("song", "joox", 1, 1);

    expect(result.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.origin).toBe(window.location.origin);
    expect(requestUrl.pathname).toBe("/music-api");
    expect(localStorage.getItem("otter_music_api_urls")).toBeNull();
  });
});
