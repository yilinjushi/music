import { describe, it, expect } from "vitest";
import {
  isSameOriginOpaqueAudioUrl,
  normalizeAudioUrlForPlayback,
} from "./audio-url";

const currentProxy = (target: string) =>
  `${window.location.origin}/proxy?url=${encodeURIComponent(target)}`;

describe("normalizeAudioUrlForPlayback", () => {
  it("converts http:// to current proxy", () => {
    expect(normalizeAudioUrlForPlayback("http://bd-er.kuwo.cn/a.mp3")).toBe(
      currentProxy("https://bd-er.kuwo.cn/a.mp3")
    );
  });

  it("explicitly recognizes and rewraps a foreign legacy proxy", () => {
    expect(
      normalizeAudioUrlForPlayback(
        "https://old-backend.example.com/proxy?url=https%3A%2F%2Fbd-er.kuwo.cn%2Fa.mp3"
      )
    ).toBe(currentProxy("https://bd-er.kuwo.cn/a.mp3"));
  });

  it("keeps a canonical current proxy url after revalidation", () => {
    const url = currentProxy("https://bd-er.kuwo.cn/a.mp3");
    expect(normalizeAudioUrlForPlayback(url)).toBe(url);
  });

  it("rejects extra fields on a current proxy envelope", () => {
    expect(() =>
      normalizeAudioUrlForPlayback(
        `${currentProxy("https://bd-er.kuwo.cn/a.mp3")}&bvid=BV1234567890`
      )
    ).toThrow("UNSAFE_PROXY_TARGET");
  });

  it("rejects a current proxy url whose nested target is signed", () => {
    expect(() =>
      normalizeAudioUrlForPlayback(
        currentProxy("https://media.example.com/a.mp3?X-Amz-Signature=canary")
      )
    ).toThrow("SENSITIVE_PROXY_TARGET");
  });

  it("rejects a foreign signed proxy instead of trusting its envelope", () => {
    expect(() =>
      normalizeAudioUrlForPlayback(
        "https://old-backend.example/proxy?url=https%3A%2F%2Fmedia.example%2Fa.mp3%3FPolicy%3Dcanary"
      )
    ).toThrow("SENSITIVE_PROXY_TARGET");
    expect(() =>
      normalizeAudioUrlForPlayback(
        "https://old-backend.example/proxy?url=https%3A%2F%2Fmedia.example%2Fa.mp3&X-Goog-Signature=canary"
      )
    ).toThrow("SENSITIVE_PROXY_TARGET");
  });

  it("rejects foreign proxy targets with HTTP or userinfo", () => {
    expect(() =>
      normalizeAudioUrlForPlayback(
        "https://old-backend.example/proxy?url=http%3A%2F%2Fmedia.example%2Fa.mp3"
      )
    ).toThrow("UNSAFE_PROXY_TARGET");
    expect(() =>
      normalizeAudioUrlForPlayback(
        "https://old-backend.example/proxy?url=https%3A%2F%2Fuser%3Apass%40media.example%2Fa.mp3"
      )
    ).toThrow("UNSAFE_PROXY_TARGET");
  });

  it("does not misclassify an ordinary foreign /proxy path without url", () => {
    expect(
      normalizeAudioUrlForPlayback("https://media.example/proxy?track=1")
    ).toBe("https://media.example/proxy?track=1");
  });

  it("keeps https direct url unchanged", () => {
    expect(normalizeAudioUrlForPlayback("https://example.com/a.mp3")).toBe(
      "https://example.com/a.mp3"
    );
  });

  it("rejects credentials, fragments and signed direct HTTPS urls", () => {
    expect(() =>
      normalizeAudioUrlForPlayback("https://user:pass@media.example/a.mp3")
    ).toThrow("UNSAFE_AUDIO_URL");
    expect(() =>
      normalizeAudioUrlForPlayback("https://media.example/a.mp3#fragment")
    ).toThrow("UNSAFE_AUDIO_URL");
    expect(() =>
      normalizeAudioUrlForPlayback(
        "https://media.example/a.mp3?vkey=private-canary"
      )
    ).toThrow("SENSITIVE_AUDIO_URL");
    expect(() =>
      normalizeAudioUrlForPlayback(
        "https://media.example/a.mp3?Cookie%253DMUSIC_U-canary"
      )
    ).toThrow("SENSITIVE_AUDIO_URL");
  });

  it("preserves a same-origin opaque media endpoint without exposing a capability", () => {
    expect(
      normalizeAudioUrlForPlayback(
        "/music-api/bilibili/audio?bvid=BV1xx411c7mD&cid=2164311"
      )
    ).toBe("/music-api/bilibili/audio?bvid=BV1xx411c7mD&cid=2164311");
  });

  it("rejects unsupported or ambiguous protocols", () => {
    expect(() => normalizeAudioUrlForPlayback("javascript:alert(1)")).toThrow(
      "UNSAFE_AUDIO_URL"
    );
    expect(() => normalizeAudioUrlForPlayback("//media.example/a.mp3")).toThrow(
      "UNSAFE_AUDIO_URL"
    );
  });

  it("keeps blob url unchanged", () => {
    expect(normalizeAudioUrlForPlayback("blob:abc")).toBe("blob:abc");
  });

  it("allows an in-memory audio data url but rejects sensitive payload text", () => {
    expect(normalizeAudioUrlForPlayback("data:audio/mpeg;base64,SUQz")).toBe(
      "data:audio/mpeg;base64,SUQz"
    );
    expect(() =>
      normalizeAudioUrlForPlayback("data:audio/mpeg,Cookie=MUSIC_U-canary")
    ).toThrow("SENSITIVE_AUDIO_URL");
  });

  it("rewraps a foreign localhost proxy after validating its HTTPS target", () => {
    expect(
      normalizeAudioUrlForPlayback(
        "http://localhost:8765/proxy?url=https%3A%2F%2Fexample.com%2Fa.m4s"
      )
    ).toBe(currentProxy("https://example.com/a.m4s"));
  });

  it("keeps a direct 127.0.0.1 development stream unchanged", () => {
    expect(
      normalizeAudioUrlForPlayback("http://127.0.0.1:8765/audio.m4s")
    ).toBe("http://127.0.0.1:8765/audio.m4s");
  });

  it("still rejects credentials and capabilities on localhost", () => {
    expect(() =>
      normalizeAudioUrlForPlayback("http://user:pass@127.0.0.1:8765/audio.m4s")
    ).toThrow("UNSAFE_AUDIO_URL");
    expect(() =>
      normalizeAudioUrlForPlayback(
        "http://127.0.0.1:8765/audio.m4s?token=canary"
      )
    ).toThrow("SENSITIVE_AUDIO_URL");
  });
});

describe("isSameOriginOpaqueAudioUrl", () => {
  it.each([
    "/music-api/audio?source=joox&id=dHJhY2s=&br=192",
    "/music-api/netease/audio?id=123&br=320000",
    "/music-api/qqmusic/audio?songmid=abc&quality=320k",
    "/music-api/migu/audio?copyrightId=a&contentId=b&br=192",
    "/music-api/bilibili/audio?bvid=BV1xx411c7mD&cid=2164311",
    `${window.location.origin}/music-api/qqmusic/audio?songmid=abc&quality=320k`,
  ])("recognizes a same-origin opaque media route: %s", (url) => {
    expect(isSameOriginOpaqueAudioUrl(url)).toBe(true);
  });

  it.each([
    "https://media.example/music-api/audio?source=joox&id=dHJhY2s=&br=192",
    "//media.example/music-api/netease/audio?id=123&br=320000",
    "/music-api/qqmusic/audio/extra?songmid=abc&quality=320k",
    "/music-api/migu/not-audio?copyrightId=a&contentId=b&br=192",
    "/music-api/audio#private-fragment",
    "not a url",
  ])("rejects an external or ambiguous lookalike: %s", (url) => {
    expect(isSameOriginOpaqueAudioUrl(url)).toBe(false);
  });
});
