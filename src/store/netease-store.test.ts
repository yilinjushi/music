import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeKey } from "./store-keys";

const profile = {
  userId: 42,
  nickname: "Store Tester",
  avatarUrl: "https://example.com/avatar.jpg",
};

describe("useNeteaseStore", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("migrates legacy state without retaining MUSIC_U", async () => {
    localStorage.setItem(
      storeKey.NeteaseStore,
      JSON.stringify({
        state: { cookie: "MUSIC_U=legacy-secret", user: profile },
        version: 0,
      })
    );
    localStorage.setItem("cookie:_netease", "MUSIC_U=other-secret");

    const { useNeteaseStore } = await import("./netease-store");
    const state = useNeteaseStore.getState();

    expect(state.authenticated).toBe(true);
    expect(state.user).toEqual(profile);
    expect("cookie" in state).toBe(false);
    expect(localStorage.getItem("cookie:_netease")).toBeNull();
    expect(localStorage.getItem(storeKey.NeteaseStore)).not.toContain(
      "MUSIC_U"
    );
  });

  it("persists only authenticated and user", async () => {
    const { useNeteaseStore } = await import("./netease-store");
    useNeteaseStore.getState().setSession(profile);

    const raw = localStorage.getItem(storeKey.NeteaseStore) || "";
    expect(raw).toContain('"authenticated":true');
    expect(raw).toContain("Store Tester");
    expect(raw.toLowerCase()).not.toContain("cookie");
  });

  it("whitelists profile fields and rewrites the previous persisted version", async () => {
    localStorage.setItem(
      storeKey.NeteaseStore,
      JSON.stringify({
        state: {
          authenticated: true,
          user: {
            ...profile,
            cookie: "MUSIC_U=profile-canary",
            unknownProviderField: "must-not-persist",
          },
        },
        version: 2,
      })
    );

    const { useNeteaseStore } = await import("./netease-store");
    expect(useNeteaseStore.getState().user).toEqual(profile);
    const raw = localStorage.getItem(storeKey.NeteaseStore) ?? "";
    expect(raw).not.toContain("profile-canary");
    expect(raw).not.toContain("unknownProviderField");
  });

  it("rewrites a contaminated current-version envelope", async () => {
    localStorage.setItem(
      storeKey.NeteaseStore,
      JSON.stringify({
        state: {
          authenticated: true,
          user: profile,
          cookie: "MUSIC_U=current-version-canary",
          unknown: "must-be-removed",
        },
        version: 3,
      })
    );

    const { useNeteaseStore } = await import("./netease-store");
    expect(useNeteaseStore.getState().user).toEqual(profile);
    const raw = localStorage.getItem(storeKey.NeteaseStore) ?? "";
    expect(raw).not.toContain("current-version-canary");
    expect(raw).not.toContain("unknown");
    expect(JSON.parse(raw)).toEqual({
      state: { authenticated: true, user: profile },
      version: 3,
    });
  });

  it("does not persist signed avatar capabilities from a session response", async () => {
    const { useNeteaseStore } = await import("./netease-store");
    useNeteaseStore.getState().setSession({
      ...profile,
      avatarUrl: "https://cdn.example/avatar.jpg?vkey=capability-canary",
    });

    expect(useNeteaseStore.getState()).toMatchObject({
      authenticated: true,
      user: {
        ...profile,
        avatarUrl: "https://cdn.example/avatar.jpg",
      },
    });
    expect(localStorage.getItem(storeKey.NeteaseStore)).not.toContain(
      "capability-canary"
    );
  });

  it("normalizes a real HTTP NetEase avatar without losing the session", async () => {
    const { useNeteaseStore } = await import("./netease-store");
    useNeteaseStore.getState().setSession({
      ...profile,
      avatarUrl: "http://p1.music.126.net/avatar.jpg?param=200y200",
    });

    expect(useNeteaseStore.getState()).toMatchObject({
      authenticated: true,
      user: {
        ...profile,
        avatarUrl: "https://p1.music.126.net/avatar.jpg",
      },
    });
  });
});
