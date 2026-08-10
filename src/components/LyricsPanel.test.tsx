import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LyricsPanel } from "./LyricsPanel";
import type { MusicTrack } from "@/types/music";

const { getLyricMock } = vi.hoisted(() => ({
  getLyricMock: vi.fn(),
}));

vi.mock("@/lib/music-api", () => ({
  musicApi: {
    getLyric: getLyricMock,
  },
}));

vi.mock("@/store/music-store", () => ({
  useMusicStore: vi.fn(() => ({
    currentAudioTime: 0,
    seek: vi.fn(),
    seekTimestamp: 0,
  })),
}));

const bilibiliTrack: MusicTrack = {
  id: "bilibili_BV1xx411c7mD",
  name: "Test Bilibili Video",
  artist: [""],
  album: "",
  pic_id: "https://example.com/pic.jpg",
  url_id: "bilibili_BV1xx411c7mD",
  lyric_id: "",
  source: "bilibili",
};

const neteaseTrack: MusicTrack = {
  id: "netease_123456",
  name: "Test Song",
  artist: ["Artist"],
  album: "Album",
  pic_id: "pic-1",
  url_id: "url-1",
  lyric_id: "lyric-1",
  source: "netease",
};

describe("LyricsPanel", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    getLyricMock.mockImplementation(() => new Promise(() => {}));
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  const renderPanel = (track: MusicTrack | null) => {
    act(() => {
      root!.render(<LyricsPanel track={track} />);
    });
  };

  const cleanup = () => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = undefined;
    container = undefined;
  };

  it("当 track 为 null 时显示提示", () => {
    renderPanel(null);
    expect(container?.textContent).toContain("选择歌曲查看歌词");
    cleanup();
  });

  it("B 站音源 lyric_id 为空时显示暂无歌词", async () => {
    renderPanel(bilibiliTrack);

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container?.textContent).toContain("暂无歌词");
    cleanup();
  });

  it("B 站音源不会显示加载中", async () => {
    renderPanel(bilibiliTrack);

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container?.textContent).not.toContain("加载歌词中...");
    cleanup();
  });

  it("正常音源加载歌词时显示加载中", () => {
    renderPanel(neteaseTrack);
    expect(container?.textContent).toContain("加载歌词中...");
    cleanup();
  });

  it("切换自无歌词曲目后会显示新曲歌词", async () => {
    renderPanel(bilibiliTrack);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("暂无歌词");

    getLyricMock.mockResolvedValueOnce({
      lyric: "[00:00.00]New lyric",
      tlyric: "",
    });
    renderPanel(neteaseTrack);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("New lyric");
    expect(container?.textContent).not.toContain("暂无歌词");
    cleanup();
  });

  it("忽略上一首曲目迟到的歌词结果", async () => {
    let resolveOld:
      ((value: { lyric: string; tlyric: string }) => void) | undefined;
    getLyricMock
      .mockImplementationOnce(
        () =>
          new Promise<{ lyric: string; tlyric: string }>((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValueOnce({
        lyric: "[00:00.00]Current lyric",
        tlyric: "",
      });

    renderPanel(neteaseTrack);
    await act(async () => {
      await Promise.resolve();
    });

    renderPanel({
      ...neteaseTrack,
      id: "netease_654321",
      lyric_id: "lyric-2",
      name: "Current Song",
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("Current lyric");

    await act(async () => {
      resolveOld?.({ lyric: "[00:00.00]Stale lyric", tlyric: "" });
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("Current lyric");
    expect(container?.textContent).not.toContain("Stale lyric");
    cleanup();
  });
});
