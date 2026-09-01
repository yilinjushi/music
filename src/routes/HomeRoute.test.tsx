import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getNeteaseSession: vi.fn(),
}));
const neteaseState = vi.hoisted(() => ({
  authenticated: false,
  user: null as unknown,
  setSession: vi.fn((user: unknown) => {
    neteaseState.authenticated = true;
    neteaseState.user = user;
  }),
  clearSession: vi.fn(() => {
    neteaseState.authenticated = false;
    neteaseState.user = null;
  }),
}));

vi.mock("@/lib/netease/netease-api", () => api);
vi.mock("@/components/NeteaseDetail", () => ({
  NeteaseDetail: ({ id }: { id: string }) => (
    <div data-testid="home-playlist">{id}</div>
  ),
}));
vi.mock("@/components/settings/NeteaseLogin", () => ({
  NeteaseLogin: ({ autoOpen }: { autoOpen?: boolean }) => (
    <div data-testid="home-login">autoOpen={String(Boolean(autoOpen))}</div>
  ),
}));
vi.mock("@/hooks/usePlayHelper", () => ({
  usePlayHelper: () => ({ handlePlay: vi.fn() }),
}));
vi.mock("@/store/music-store", () => ({
  useMusicStore: (selector: (state: unknown) => unknown) =>
    selector({ queue: [], currentIndex: 0, isPlaying: false }),
}));
vi.mock("@/store/netease-store", () => ({
  useNeteaseStore: (selector: (state: typeof neteaseState) => unknown) =>
    selector(neteaseState),
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

import { HomeRoute } from "./HomeRoute";

const profile = {
  userId: 42,
  nickname: "Home Tester",
  avatarUrl: "https://example.com/avatar.jpg",
};

describe("HomeRoute", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    neteaseState.authenticated = false;
    neteaseState.user = null;
    api.getNeteaseSession.mockResolvedValue(null);
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens the fixed NetEase liked playlist after the server session is confirmed", async () => {
    api.getNeteaseSession.mockResolvedValue(profile);

    await act(async () => {
      root.render(<HomeRoute />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid=home-playlist]")?.textContent).toBe(
      "neplaylist_366135532"
    );
    expect(container.querySelector("[data-testid=home-login]")).toBeNull();
  });

  it("opens QR login automatically when the server reports no NetEase session", async () => {
    await act(async () => {
      root.render(<HomeRoute />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid=home-login]")?.textContent).toBe(
      "autoOpen=true"
    );
    expect(container.querySelector("[data-testid=home-playlist]")).toBeNull();
  });
});
