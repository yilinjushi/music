import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createSanitizingStateStorage } from "@/lib/storage-adapter";
import {
  ARTIST_ALBUM_FLOW_CACHE_VERSION,
  MARKET_SESSION_VERSION,
  sanitizeArtistAlbumFlowCache,
  sanitizePersistedMarketSessionState,
} from "./market-session-clean";
import {
  createArtistAlbumFlowCacheKey,
  readArtistAlbumFlowCache,
} from "./artist-album-flow-cache";

const playlist = {
  id: "playlist-1",
  name: "Safe playlist",
  coverUrl: "https://cdn.example/cover.jpg",
  playCount: 12,
};

const album = {
  id: 42,
  name: "Safe album",
  picUrl: "https://cdn.example/album.jpg",
  publishTime: 1_700_000_000_000,
  size: 10,
  artist: {
    id: 7,
    name: "Artist",
    picUrl: "https://cdn.example/artist.jpg",
    albumSize: 3,
  },
};

describe("market session persistence schema", () => {
  it("retains only explicit playlist/album fields", () => {
    const clean = sanitizePersistedMarketSessionState({
      mineData: {
        recommend: [{ ...playlist, upstreamOnly: "strip-me" }],
        created: null,
        subscribed: null,
        albums: [
          {
            ...album,
            artist: { ...album.artist, upstreamOnly: "strip-me" },
            upstreamOnly: "strip-me",
          },
        ],
        hasMoreAlbums: false,
        upstreamOnly: "strip-me",
      },
      listSnapshots: {
        safe: {
          items: [{ ...playlist, upstreamOnly: "strip-me" }],
          offset: 30,
          hasMore: true,
          upstreamOnly: "strip-me",
        },
      },
      searchCache: {
        query: "music",
        items: [playlist],
        offset: 0,
        hasMore: false,
        upstreamOnly: "strip-me",
      },
      upstreamOnly: "strip-me",
    });

    expect(clean).toEqual({
      mineData: {
        recommend: [playlist],
        created: null,
        subscribed: null,
        albums: [album],
        hasMoreAlbums: false,
      },
      listSnapshots: {
        safe: { items: [playlist], offset: 30, hasMore: true },
      },
      searchCache: {
        query: "music",
        items: [playlist],
        offset: 0,
        hasMore: false,
      },
    });
  });

  it.each([
    "wsSecret%2525253Dfour-pass-canary",
    "wsTime%2525253Dfour-pass-canary",
    "sign%2525253Dfour-pass-canary",
    "session_id%2525253Dfour-pass-canary",
    "X-API-Key%2525253Dfour-pass-canary",
  ])("drops a playlist carrying encoded capability data: %s", (pollution) => {
    const clean = sanitizePersistedMarketSessionState({
      mineData: {
        recommend: [{ ...playlist, providerData: pollution }],
      },
    });
    expect(clean.mineData.recommend).toEqual([]);
    expect(JSON.stringify(clean)).not.toContain("four-pass-canary");
  });

  it("rejects signed cover capabilities but permits ordinary design metadata", () => {
    const clean = sanitizePersistedMarketSessionState({
      mineData: {
        recommend: [
          {
            ...playlist,
            coverUrl: "https://cdn.example/cover.jpg?wsSecret=canary&wsTime=1",
          },
          { ...playlist, id: "playlist-2", design: "public metadata" },
        ],
      },
    });
    expect(clean.mineData.recommend).toEqual([
      { ...playlist, id: "playlist-2" },
    ]);
  });

  it("forces a clean writeback even when the envelope already has the current version", async () => {
    let raw = JSON.stringify({
      state: {
        mineData: {
          recommend: [{ ...playlist, wsSecret: "current-canary" }],
        },
        listSnapshots: {},
        searchCache: null,
        x_auth_token: "current-canary",
      },
      version: MARKET_SESSION_VERSION,
    });
    const base: StateStorage = {
      getItem: () => raw,
      setItem: (_key, value) => {
        raw = value;
      },
      removeItem: () => undefined,
    };
    const storage = createSanitizingStateStorage(base, {
      version: MARKET_SESSION_VERSION,
      sanitize: sanitizePersistedMarketSessionState,
    });

    await storage.getItem("market-session-storage");
    expect(raw).not.toContain("current-canary");
    expect(JSON.parse(raw)).toEqual({
      state: sanitizePersistedMarketSessionState({
        mineData: { recommend: [{ ...playlist, wsSecret: "removed" }] },
      }),
      version: MARKET_SESSION_VERSION,
    });
  });
});

describe("artist album flow cache", () => {
  it("uses only bounded numeric artist identifiers as storage keys", () => {
    expect(createArtistAlbumFlowCacheKey("123")).toBe("artist-album-flow:123");
    expect(createArtistAlbumFlowCacheKey("session_id=canary")).toBeNull();
    expect(createArtistAlbumFlowCacheKey("../other-key")).toBeNull();
  });

  it("rewrites a polluted current cache with an explicit empty schema", () => {
    const key = "artist-album-flow:42";
    sessionStorage.setItem(
      key,
      JSON.stringify({
        version: ARTIST_ALBUM_FLOW_CACHE_VERSION,
        albums: [album],
        offset: 30,
        hasMore: true,
        scrollTop: 12,
        session_id: "current-cache-canary",
      })
    );

    expect(readArtistAlbumFlowCache(sessionStorage, key)).toEqual({
      version: ARTIST_ALBUM_FLOW_CACHE_VERSION,
      albums: [],
      offset: 0,
      hasMore: true,
      scrollTop: 0,
    });
    expect(sessionStorage.getItem(key)).not.toContain("current-cache-canary");
  });

  it("migrates an unversioned safe cache and strips unknown provider fields", () => {
    const clean = sanitizeArtistAlbumFlowCache({
      albums: [{ ...album, upstreamOnly: "strip-me" }],
      offset: 30,
      hasMore: false,
      scrollTop: 200,
      upstreamOnly: "strip-me",
    });
    expect(clean).toEqual({
      version: ARTIST_ALBUM_FLOW_CACHE_VERSION,
      albums: [album],
      offset: 30,
      hasMore: false,
      scrollTop: 200,
    });
  });
});
