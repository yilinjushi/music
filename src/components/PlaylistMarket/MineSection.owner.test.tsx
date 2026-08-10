import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MineSection } from "./MineSection";
import { useNeteaseStore } from "@/store/netease-store";
import { useMarketSession } from "@/store/session/market-session";
import { useMusicStore } from "@/store/music-store";

const api = vi.hoisted(() => ({
  getRecommendPlaylists: vi.fn(),
  getUserPlaylists: vi.fn(),
  getSubscribedAlbums: vi.fn(),
}));
const idbStorage = vi.hoisted(() => ({
  getItem: vi.fn().mockResolvedValue(null),
  setItem: vi.fn().mockResolvedValue(undefined),
  removeItem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/netease/netease-api", () => api);
vi.mock("@/lib/storage-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage-adapter")>()),
  idbStorage,
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/MusicCover", () => ({
  MusicCover: ({ alt }: { alt: string }) => <div>{alt}</div>,
}));
vi.mock("./PlaylistGrid", () => ({
  PlaylistGrid: ({ list }: { list: Array<{ name: string }> }) => (
    <div>{list.map((item) => item.name).join(",")}</div>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children?: ReactNode;
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const oldUser = {
  userId: 42,
  nickname: "Old session",
  avatarUrl: "https://example.com/old.jpg",
};
const newUser = {
  userId: 42,
  nickname: "New session",
  avatarUrl: "https://example.com/new.jpg",
};
const oldPlaylist = {
  id: "old-list",
  name: "Old list",
  coverUrl: "https://example.com/old-list.jpg",
  playCount: 1,
};
const newPlaylist = {
  id: "new-list",
  name: "New list",
  coverUrl: "https://example.com/new-list.jpg",
  playCount: 2,
};
const oldAlbum = {
  id: 1,
  name: "Old album",
  picUrl: "https://example.com/old-album.jpg",
  publishTime: 1,
  size: 1,
};
const newAlbum = {
  id: 2,
  name: "New album",
  picUrl: "https://example.com/new-album.jpg",
  publishTime: 2,
  size: 2,
};
const staleAlbum = {
  id: 3,
  name: "Stale page",
  picUrl: "https://example.com/stale-album.jpg",
  publishTime: 3,
  size: 3,
};

describe("MineSection session request ownership", () => {
  let root: Root;
  let container: HTMLDivElement;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getRecommendPlaylists.mockImplementation(() => new Promise(() => {}));
    api.getUserPlaylists.mockImplementation(() => new Promise(() => {}));
    api.getSubscribedAlbums.mockImplementation(() => new Promise(() => {}));
    useNeteaseStore.getState().clearSession();
    useMarketSession.getState().clearSession();
    useMusicStore.getState().setLastMineTab("recommend");
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

  it("rejects a late first-page result after the same user logs into a new session", async () => {
    const oldRequest = deferred<(typeof oldPlaylist)[]>();
    const newRequest = deferred<(typeof newPlaylist)[]>();
    api.getRecommendPlaylists
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    useNeteaseStore.getState().setSession(oldUser);

    act(() => root.render(<MineSection />));
    await flush();
    const oldSignal = api.getRecommendPlaylists.mock.calls[0][1] as AbortSignal;
    expect(oldSignal.aborted).toBe(false);

    act(() => {
      useNeteaseStore.getState().clearSession();
      useNeteaseStore.getState().setSession(newUser);
    });
    await flush();
    expect(oldSignal.aborted).toBe(true);
    expect(api.getRecommendPlaylists).toHaveBeenCalledTimes(2);

    await act(async () => oldRequest.resolve([oldPlaylist]));
    expect(useMarketSession.getState().mineData.recommend).toBeNull();

    await act(async () => newRequest.resolve([newPlaylist]));
    expect(useMarketSession.getState().mineData.recommend).toEqual([
      newPlaylist,
    ]);
  });

  it("aborts load-more and prevents its late page from entering a new session", async () => {
    const loadMore = deferred<(typeof staleAlbum)[]>();
    api.getSubscribedAlbums.mockReturnValueOnce(loadMore.promise);
    useMusicStore.getState().setLastMineTab("albums");
    useNeteaseStore.getState().setSession(oldUser);
    useMarketSession.getState().setMineData({
      albums: [oldAlbum],
      hasMoreAlbums: true,
    });

    act(() => root.render(<MineSection />));
    await flush();
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("加载更多")
    );
    expect(button).toBeDefined();
    act(() => button!.click());
    await flush();
    const oldSignal = api.getSubscribedAlbums.mock.calls[0][3] as AbortSignal;
    expect(oldSignal.aborted).toBe(false);

    act(() => {
      useNeteaseStore.getState().clearSession();
      useMarketSession.getState().clearSession();
      useNeteaseStore.getState().setSession(newUser);
      useMarketSession.getState().setMineData({
        albums: [newAlbum],
        hasMoreAlbums: true,
      });
    });
    await flush();
    expect(oldSignal.aborted).toBe(true);

    await act(async () => loadMore.resolve([staleAlbum]));
    expect(useMarketSession.getState().mineData.albums).toEqual([newAlbum]);
  });
});
