import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { RootLayout } from "./RootLayout";
import { useMusicStore } from "@/store/music-store";
import { useExitLayerStore } from "@/hooks/useExitLayer";
import type { MusicTrack } from "@/types/music";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("react-hot-toast", () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/utils/toast", () => ({
  toastUtils: {
    info: vi.fn(),
  },
}));

vi.mock("@/hooks/useMusicCover", () => ({
  useMusicCover: vi.fn(() => null),
}));

vi.mock("@/components/MusicLayout", () => ({
  MusicLayout: ({
    children,
    player,
    tabBar,
  }: {
    children: ReactNode;
    player: ReactNode;
    tabBar: ReactNode;
  }) => (
    <div>
      <div data-testid="player-slot">{player}</div>
      <div data-testid="content">{children}</div>
      <div data-testid="tabbar-slot">{tabBar}</div>
    </div>
  ),
}));

vi.mock("@/components/MusicNowPlayingBar", () => ({
  MusicNowPlayingBar: () => <div>Now Playing</div>,
}));

vi.mock("@/components/MusicTabBar", () => ({
  MusicTabBar: () => <div>Tab Bar</div>,
}));

vi.mock("@/components/GlobalMusicPlayer", () => ({
  GlobalMusicPlayer: () => <div>Global Player</div>,
}));

vi.mock("@/components/FullScreenPlayer", () => ({
  FullScreenPlayer: ({ isFullScreen }: { isFullScreen: boolean }) => (
    <div data-testid="fullscreen-state">{isFullScreen ? "open" : "closed"}</div>
  ),
}));

const track: MusicTrack = {
  id: "track-1",
  name: "Song",
  artist: ["Artist"],
  album: "Album",
  pic_id: "pic-1",
  url_id: "url-1",
  lyric_id: "lyric-1",
  source: "netease",
};

describe("RootLayout", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();

    useMusicStore.setState({
      queue: [track],
      currentIndex: 0,
      isPlaying: false,
      isLoading: false,
      isRepeat: false,
      isShuffle: false,
      isFullScreenPlayer: false,
      favorites: [],
    });

    useExitLayerStore.setState({ stack: [] });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = undefined;
    container = undefined;
  });

  const renderLayout = (initialEntries: string[], initialIndex = 0) => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <RootLayout />,
          children: [
            { path: "search", element: <div>Search Page</div> },
            { path: "playlist/:id", element: <div>Playlist Page</div> },
          ],
        },
      ],
      { initialEntries, initialIndex }
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(<RouterProvider router={router} />);
    });

    return { router };
  };

  it("closes the fullscreen player on real Escape without registering popstate handling", async () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    useMusicStore.setState({ isFullScreenPlayer: true });

    renderLayout(["/search"]);

    await vi.dynamicImportSettled();
    await act(async () => {});

    expect(
      container?.querySelector('[data-testid="fullscreen-state"]')?.textContent
    ).toBe("open");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(useMusicStore.getState().isFullScreenPlayer).toBe(false);
    expect(
      container?.querySelector('[data-testid="fullscreen-state"]')?.textContent
    ).toBe("closed");
    expect(
      addEventListenerSpy.mock.calls.some(
        ([eventName]) => (eventName as string) === "popstate"
      )
    ).toBe(false);

    addEventListenerSpy.mockRestore();
  });

  it("handles nested fullscreen + drawer in LIFO order on Escape", async () => {
    // 模拟一个 Drawer 先入栈
    const drawerClose = vi.fn();
    useExitLayerStore.getState().push({ close: drawerClose });

    renderLayout(["/"]);

    // 全屏页入栈（晚于 Drawer）
    await act(async () => {
      useMusicStore.setState({ isFullScreenPlayer: true });
    });

    expect(useExitLayerStore.getState().stack).toHaveLength(2);

    // 第一次 Escape：先关全屏
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(useMusicStore.getState().isFullScreenPlayer).toBe(false);
    expect(drawerClose).not.toHaveBeenCalled();
    expect(useExitLayerStore.getState().stack).toHaveLength(1);

    // 第二次 Escape：再关 Drawer
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(drawerClose).toHaveBeenCalledTimes(1);
    expect(useExitLayerStore.getState().stack).toHaveLength(0);
  });

  it("loads the audio runtime only after a current track exists", async () => {
    useMusicStore.setState({ queue: [], currentIndex: 0 });
    renderLayout(["/search"]);

    await vi.dynamicImportSettled();
    await act(async () => {});
    expect(container?.textContent).not.toContain("Global Player");

    await act(async () => {
      useMusicStore.setState({ queue: [track], currentIndex: 0 });
    });
    await vi.dynamicImportSettled();
    await act(async () => {});

    expect(container?.textContent).toContain("Global Player");
  });
});
