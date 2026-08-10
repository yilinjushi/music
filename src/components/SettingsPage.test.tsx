import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { useMusicStore } from "@/store/music-store";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("./settings/NeteaseLogin", () => ({
  NeteaseLogin: () => <div>网易云账号</div>,
}));

vi.mock("./settings/AggregatedSourceSelect", () => ({
  AggregatedSourceSelect: () => <div>首屏音源设置</div>,
}));

vi.mock("./settings/QualitySelect", () => ({
  QualitySelect: () => <div>首屏音质设置</div>,
}));

vi.mock("./settings/SettingItem", () => ({
  SettingItem: ({ title, action }: { title: string; action?: ReactNode }) => (
    <div>
      {title}
      {action}
    </div>
  ),
}));

vi.mock("./ui/slider", () => ({
  Slider: ({ "aria-label": ariaLabel }: { "aria-label": string }) => (
    <div aria-label={ariaLabel} />
  ),
}));

describe("SettingsPage loading boundary", () => {
  let root: Root;
  let container: HTMLDivElement;
  let animationFrames: FrameRequestCallback[];

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useMusicStore.setState({ volume: 0.5 });
    animationFrames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("commits the above-the-fold controls before deferred settings resolve", async () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      );
    });

    expect(container.textContent).toContain("系统设置");
    expect(container.textContent).toContain("首屏音源设置");
    expect(container.textContent).not.toContain("首屏音质设置");
    expect(container.textContent).not.toContain("音量调节");
    expect(container.textContent).not.toContain("界面设置");
    expect(container.textContent).not.toContain("账号数据");

    await act(async () => {
      animationFrames.shift()?.(0);
    });

    expect(container.textContent).not.toContain("首屏音质设置");
    expect(container.textContent).not.toContain("音量调节");

    await act(async () => {
      animationFrames.shift()?.(16);
    });

    await act(async () => {
      await vi.dynamicImportSettled();
    });

    expect(container.textContent).toContain("首屏音质设置");
    expect(container.textContent).toContain("音量调节");
    expect(container.textContent).toContain("界面设置");
    expect(container.textContent).toContain("账号数据");
    expect(container.textContent).not.toContain("数据同步");
  });
});
