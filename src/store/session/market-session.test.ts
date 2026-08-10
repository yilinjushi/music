import { beforeEach, describe, expect, it } from "vitest";
import { storeKey } from "@/store/store-keys";
import { MARKET_SESSION_VERSION } from "./market-session-clean";
import { clearMarketSession, useMarketSession } from "./market-session";

const playlist = {
  id: "playlist-1",
  name: "Safe playlist",
  coverUrl: "https://cdn.example/cover.jpg",
  playCount: 12,
};

describe("market session store persistence", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    useMarketSession.getState().clearSession();
    await useMarketSession.persist.rehydrate();
  });

  it("cleans direct state bypasses before partializing", () => {
    useMarketSession.setState({
      mineData: {
        recommend: [
          {
            ...playlist,
            upstreamOnly: "strip-me",
            x_auth_token: "direct-canary",
          },
        ],
        created: null,
        subscribed: null,
        albums: null,
        hasMoreAlbums: true,
        session_id: "direct-canary",
      },
      listSnapshots: {},
      searchCache: null,
      upstreamOnly: "strip-me",
    } as never);

    const partialize = useMarketSession.persist.getOptions().partialize!;
    const persisted = partialize(useMarketSession.getState());
    expect(persisted).toEqual({
      mineData: {
        recommend: [],
        created: null,
        subscribed: null,
        albums: null,
        hasMoreAlbums: true,
      },
      listSnapshots: {},
      searchCache: null,
    });
    expect(JSON.stringify(persisted)).not.toMatch(/canary|strip-me/);
  });

  it("rejects signed runtime writes", () => {
    useMarketSession.setState({
      mineData: {
        recommend: null,
        created: null,
        subscribed: [],
        albums: null,
        hasMoreAlbums: true,
      },
    });
    useMarketSession.getState().togglePlaylistInSession(
      {
        ...playlist,
        coverUrl: "https://cdn.example/cover.jpg?sign=runtime-canary",
      },
      true
    );

    expect(useMarketSession.getState().mineData.subscribed).toEqual([]);
    expect(sessionStorage.getItem(storeKey.MarketSessionStore)).not.toContain(
      "runtime-canary"
    );
  });

  it("rewrites a polluted current-version session on rehydrate", async () => {
    sessionStorage.setItem(
      storeKey.MarketSessionStore,
      JSON.stringify({
        state: {
          mineData: {
            recommend: [{ ...playlist, wsSecret: "hydrate-canary" }],
          },
          listSnapshots: {},
          searchCache: null,
        },
        version: MARKET_SESSION_VERSION,
      })
    );

    await useMarketSession.persist.rehydrate();
    const raw = sessionStorage.getItem(storeKey.MarketSessionStore) ?? "";
    expect(raw).not.toContain("hydrate-canary");
    expect(useMarketSession.getState().mineData.recommend).toEqual([]);
  });

  it("awaitably removes account-derived live and persisted state", async () => {
    useMarketSession.getState().setMineData({ recommend: [playlist] });
    expect(useMarketSession.getState().mineData.recommend).toEqual([playlist]);
    expect(sessionStorage.getItem(storeKey.MarketSessionStore)).not.toBeNull();

    await clearMarketSession();

    expect(useMarketSession.getState().mineData).toEqual({
      recommend: null,
      created: null,
      subscribed: null,
      albums: null,
      hasMoreAlbums: true,
    });
    expect(useMarketSession.getState().listSnapshots).toEqual({});
    expect(useMarketSession.getState().searchCache).toBeNull();
    expect(sessionStorage.getItem(storeKey.MarketSessionStore)).toBeNull();
  });
});
