import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MUSIC_API_URL,
  getApiUrl,
  getCustomApiUrl,
  getMusicApiUrls,
  getOrderedMusicApiUrls,
  getProxyUrl,
  isProxyUrl,
  markMusicApiUrlFailure,
  setCustomApiUrl,
  setMusicApiUrls,
  unwrap,
} from "./config";

const sameOriginMusicApi = () =>
  `${window.location.origin}${DEFAULT_MUSIC_API_URL}`;

describe("same-origin API route policy", () => {
  beforeEach(() => localStorage.clear());

  it("uses only the same-origin BFF music endpoint", () => {
    expect(getMusicApiUrls()).toEqual([sameOriginMusicApi()]);

    setMusicApiUrls([DEFAULT_MUSIC_API_URL]);
    expect(getOrderedMusicApiUrls()).toEqual([sameOriginMusicApi()]);
  });

  it("rejects cross-origin, credentialed, and sensitive endpoint values", () => {
    expect(() => setMusicApiUrls(["https://external.test/music-api"])).toThrow(
      "UNSAFE_MUSIC_API_URL"
    );
    expect(() =>
      setMusicApiUrls([
        `https://user:password@${window.location.host}/music-api`,
      ])
    ).toThrow("UNSAFE_MUSIC_API_URL");
    expect(() =>
      setMusicApiUrls([`${DEFAULT_MUSIC_API_URL}?api_token=canary`])
    ).toThrow("UNSAFE_MUSIC_API_URL");
  });

  it("purges a legacy cross-origin endpoint instead of returning it", () => {
    localStorage.setItem(
      "otter_music_api_urls",
      JSON.stringify(["https://legacy.test/api.php?MUSIC_U=canary"])
    );

    expect(getMusicApiUrls()).toEqual([sameOriginMusicApi()]);
    expect(localStorage.getItem("otter_music_api_urls")).toBeNull();
  });

  it("never lets failure bookkeeping introduce a foreign URL", () => {
    markMusicApiUrlFailure("https://external.test/music-api", 1_000);
    markMusicApiUrlFailure(sameOriginMusicApi(), 1_000);

    expect(getOrderedMusicApiUrls(1_000)).toEqual([sameOriginMusicApi()]);
    expect(localStorage.getItem("otter_music_api_url_failures")).not.toContain(
      "external.test"
    );
  });

  it("validates the custom API at the central storage boundary", () => {
    setCustomApiUrl(window.location.origin);
    expect(getCustomApiUrl()).toBe(window.location.origin);
    expect(getApiUrl()).toBe(window.location.origin);

    expect(() => setCustomApiUrl("https://external.test")).toThrow(
      "UNSAFE_API_ORIGIN"
    );
    expect(() =>
      setCustomApiUrl(`${window.location.origin}?api_token=canary`)
    ).toThrow("UNSAFE_API_ORIGIN");
  });

  it("rejects sensitive proxy targets before they enter an application URL", () => {
    expect(() =>
      getProxyUrl("https://media.test/a.mp3?X-Amz-Signature=canary")
    ).toThrow("SENSITIVE_PROXY_TARGET");
    expect(() => getProxyUrl("https://user:password@media.test/a.mp3")).toThrow(
      "UNSAFE_PROXY_TARGET"
    );
    expect(() => getProxyUrl("http://media.test/a.mp3")).toThrow(
      "UNSAFE_PROXY_TARGET"
    );

    const safe = getProxyUrl("https://media.test/a.mp3?id=public-id");
    expect(new URL(safe).origin).toBe(window.location.origin);
    expect(isProxyUrl(safe)).toBe(true);
    expect(isProxyUrl("https://external.test/proxy?url=x")).toBe(false);
  });

  it("preserves HTTP status on non-ok responses", async () => {
    const response = new Response("missing", { status: 404 });

    await expect(unwrap(response)).rejects.toMatchObject({
      name: "ApiError",
      message: "missing",
      status: 404,
    });
  });
});
