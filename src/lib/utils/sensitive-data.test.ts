import { describe, expect, it } from "vitest";
import {
  assertNoSensitiveData,
  containsSensitiveData,
  sanitizeTrackForPersistence,
  sanitizePlaylistForPersistence,
  stringContainsSensitiveAssignment,
  validateDirectAudioUrl,
  validatePersistableDirectTrackUrl,
  validatePersistableResourceReference,
} from "./sensitive-data";

const safeTrack = {
  id: "1",
  name: "Song",
  artist: ["Artist"],
  album: "Album",
  pic_id: "cover",
  url_id: "https://media.example/song.mp3",
  lyric_id: "lyric",
  source: "url",
};

describe("sensitive data ingress guard", () => {
  it.each([
    "Authorization: Bearer canary",
    "Cookie=MUSIC_U-canary",
    "credential=canary",
    "csrf_token: canary",
    "MUSIC_U=canary",
    "Set-Cookie: MUSIC_U=canary",
    "x-real-cookie=canary",
    "Proxy-Authorization: Basic canary",
    "Proxy Authorization: Basic canary",
    "token=capability-canary",
    "api_token=capability-canary",
    "secret=capability-canary",
    "X-Request-Key=capability-canary",
    "sessionId=credential-canary",
    "session_id=credential-canary",
    "X-API-Key=credential-canary",
    "X-Auth-Token=credential-canary",
    "vkey=capability-canary",
    "upsig=capability-canary",
    "deadline=capability-canary",
    "wsSecret=capability-canary",
    "wsTime=capability-canary",
    "sign=capability-canary",
    "__token__=capability-canary",
    "auth_key=capability-canary",
    "Signature=capability-canary",
    "X-Amz-Credential=capability-canary",
    "X-Goog-Signature=capability-canary",
    "GoogleAccessId=capability-canary",
    "Key-Pair-Id=capability-canary",
  ])("detects a plain sensitive assignment: %s", (value) => {
    expect(stringContainsSensitiveAssignment(value)).toBe(true);
  });

  it.each([
    "Authorization%3ABearer%20canary",
    "Cookie%253DMUSIC_U%252Dcanary",
    "MUSIC_U%25253Dtriple-canary",
    "api_token%2525253Dfour-pass-canary",
    "vkey%2525253Dfour-pass-canary",
    "upsig%2525253Dfour-pass-canary",
    "deadline%2525253Dfour-pass-canary",
    "wsSecret%2525253Dfour-pass-canary",
    "wsTime%2525253Dfour-pass-canary",
    "sign%2525253Dfour-pass-canary",
    "session_id%2525253Dfour-pass-canary",
    "X-API-Key%2525253Dfour-pass-canary",
    "bad%ZZ&Cookie%3DMUSIC_U-canary",
  ])("detects encoded sensitive assignments: %s", (value) => {
    expect(stringContainsSensitiveAssignment(value)).toBe(true);
  });

  it("recurses through arbitrary unknown fields and encoded object keys", () => {
    expect(
      containsSensitiveData({
        arbitrary: [{ nested: { "x%252Dreal%252Dcookie": "canary" } }],
      })
    ).toBe(true);
    expect(
      containsSensitiveData({ "api_token%2525253Dkey-canary": "value" })
    ).toBe(true);
    expect(() =>
      assertNoSensitiveData({ metadata: { note: "ordinary liner notes" } })
    ).not.toThrow();
  });

  it("does not treat ordinary words containing sign as sensitive fields", () => {
    expect(stringContainsSensitiveAssignment("design=public metadata")).toBe(
      false
    );
    expect(
      stringContainsSensitiveAssignment("albumSignLanguage=ordinary")
    ).toBe(false);
    expect(
      containsSensitiveData({
        note: "A signed public release",
        design: "clean",
      })
    ).toBe(false);
  });

  it("fails closed for cycles and strips runtime-only track fields", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(containsSensitiveData(cyclic)).toBe(true);

    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        variants: [safeTrack],
        privilege: { fee: 0 },
      })
    ).toEqual(safeTrack);
  });

  it("rejects sensitive fields anywhere in a track", () => {
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        arbitrary: { note: "cookie%253DMUSIC_U-canary" },
      })
    ).toBeNull();
  });

  it("persists only explicit track and playlist fields", () => {
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        unknownProviderField: "must-not-persist",
        variants: [safeTrack],
        privilege: { fee: 0 },
      })
    ).toEqual(safeTrack);

    expect(
      sanitizePlaylistForPersistence({
        id: "playlist-1",
        name: "Safe list",
        createdAt: 1,
        tracks: [safeTrack],
        description: "notes",
        unknownPlaylistField: "must-not-persist",
      })
    ).toEqual({
      id: "playlist-1",
      name: "Safe list",
      createdAt: 1,
      tracks: [safeTrack],
      description: "notes",
    });
  });

  it("requires a known MusicSource and opaque provider identifiers", () => {
    expect(
      sanitizeTrackForPersistence({ ...safeTrack, source: "unknown-source" })
    ).toBeNull();
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        source: "netease",
        url_id: "https://media.example/song.mp3",
      })
    ).toBeNull();
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        source: "netease",
        url_id: "user:password@media.example",
      })
    ).toBeNull();
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        source: "netease",
        url_id: "api_token=capability-canary",
      })
    ).toBeNull();
  });

  it.each([
    "Bearer account-secret",
    "Basic YWNjb3VudC1zZWNyZXQ=",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMiLCJleHAiOjk5OTk5OTk5OTl9.dGVzdC1zaWduYXR1cmUtYnl0ZXM",
    "https://credential.example/id",
    "user:password@credential.example",
    "nul%00byte",
    "tab%09break",
    "line%0Abreak",
    "carriage%0Dreturn",
    "unit%1Fseparator",
    "delete%7Fcharacter",
  ])("rejects encoded credential-shaped opaque identifiers: %s", (value) => {
    for (let passes = 1; passes <= 4; passes += 1) {
      let encoded = value;
      for (let pass = 0; pass < passes; pass += 1) {
        encoded = encodeURIComponent(encoded);
      }
      expect(
        sanitizeTrackForPersistence({
          ...safeTrack,
          source: "netease",
          id: encoded,
          url_id: "safe-id",
        })
      ).toBeNull();
    }
  });

  it.each(["abc.def.ghi", "www.youtube.com", "Basic Instinct"])(
    "keeps legitimate opaque music metadata: %s",
    (value) => {
      expect(
        sanitizeTrackForPersistence({
          ...safeTrack,
          source: "migu",
          id: value,
          url_id: value,
        })
      ).toMatchObject({ id: value, url_id: value });
    }
  );

  it("closes the source=url backup/sync bypass", () => {
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        url_id: "http://media.example/song.mp3",
      })
    ).toBeNull();
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        url_id: "https://media.example/song.mp3?secret=capability-canary",
      })
    ).toBeNull();
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        url_id:
          "https://media.example/song.mp3?vkey=capability-canary&deadline=1",
      })
    ).toBeNull();
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        url_id: "/e2e-media/sample.mp3",
      })
    ).toEqual({ ...safeTrack, url_id: "/e2e-media/sample.mp3" });
  });

  it("requires HTTPS for direct user-entered URLs", () => {
    expect(
      validateDirectAudioUrl("https://media.example/song.mp3")
    ).not.toBeNull();
    expect(validateDirectAudioUrl("http://media.example/song.mp3")).toBeNull();
    expect(validateDirectAudioUrl("http://localhost:5173/song.mp3")).toBeNull();
    expect(validateDirectAudioUrl("http://127.0.0.1/song.mp3")).toBeNull();
    expect(
      validateDirectAudioUrl("https://user:secret@media.example/a.mp3")
    ).toBeNull();
    expect(
      validateDirectAudioUrl("https://media.example/a.mp3?MUSIC_U=canary")
    ).toBeNull();
    expect(
      validateDirectAudioUrl("https://media.example/a.mp3?opaque=capability")
    ).toBeNull();
  });

  it("rejects signed artwork and lyric capabilities before persistence", () => {
    expect(
      validatePersistableResourceReference(
        "https://cdn.example/cover.jpg?vkey=capability-canary"
      )
    ).toBe(false);
    expect(
      validatePersistableResourceReference(
        "https://cdn.example/cover.jpg?wsSecret=capability-canary&wsTime=1"
      )
    ).toBe(false);
    expect(
      validatePersistableResourceReference(
        "https://cdn.example/cover.jpg?sign%2525253Dcapability-canary"
      )
    ).toBe(false);
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        pic_id:
          "https://cdn.example/cover.jpg?upsig=capability-canary&deadline=1",
      })
    ).toBeNull();
    expect(
      sanitizePlaylistForPersistence({
        id: "playlist-1",
        name: "Unsafe cover",
        createdAt: 1,
        tracks: [safeTrack],
        coverUrl: "https://cdn.example/cover.jpg?X-Amz-Signature=canary",
      })
    ).toBeNull();
  });

  it.each([
    "https://cdn.example/cover.jpg?txSecret=random-unknown-canary",
    "https://cdn.example/cover.jpg?unrecognized_signature=random-canary",
    "https://cdn.example/cover.jpg#private-fragment-canary",
    "https://user:password@cdn.example/cover.jpg",
    "/covers/cover.jpg?publicResize=800",
    "/lyrics/song.lrc#verse",
    "covers/cover.jpg?opaque=random-canary",
    "https%253A%252F%252Fcdn.example%252Fcover.jpg%253Funknown%253Drandom-canary",
  ])("rejects every stateful persisted resource URL: %s", (reference) => {
    expect(validatePersistableResourceReference(reference)).toBe(false);
  });

  it("accepts query-free public and relative resource references", () => {
    expect(
      validatePersistableResourceReference("https://cdn.example/cover.jpg")
    ).toBe(true);
    expect(validatePersistableResourceReference("/covers/cover.jpg")).toBe(
      true
    );
    expect(validatePersistableResourceReference("covers/cover.jpg")).toBe(true);
    expect(validatePersistableResourceReference("provider-cover-id")).toBe(
      true
    );
  });

  it("rejects unknown query state from track, lyric, and playlist persistence", () => {
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        pic_id: "https://cdn.example/cover.jpg?txSecret=random-canary",
      })
    ).toBeNull();
    expect(
      sanitizeTrackForPersistence({
        ...safeTrack,
        lyric_id: "/lyrics/song.lrc?opaque=random-canary",
      })
    ).toBeNull();
    expect(
      sanitizePlaylistForPersistence({
        id: "playlist-1",
        name: "Unsafe cover",
        createdAt: 1,
        tracks: [safeTrack],
        coverUrl: "https://cdn.example/cover.jpg?random=random-canary",
      })
    ).toBeNull();
  });

  it("allows only HTTPS or a single-slash same-origin fixture for source=url tracks", () => {
    expect(
      validatePersistableDirectTrackUrl("https://media.example/a.mp3")
    ).toBe(true);
    expect(validatePersistableDirectTrackUrl("/e2e-media/sample.mp3")).toBe(
      true
    );
    expect(validatePersistableDirectTrackUrl("//evil.example/sample.mp3")).toBe(
      false
    );
    expect(
      validatePersistableDirectTrackUrl("/\\evil.example/sample.mp3")
    ).toBe(false);
    expect(
      validatePersistableDirectTrackUrl("http://localhost/sample.mp3")
    ).toBe(false);
    expect(
      validatePersistableDirectTrackUrl("/e2e-media/a.mp3?signature=canary")
    ).toBe(false);
  });
});
