import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PwaInstallPrompt } from "./PwaInstallPrompt";

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("react-hot-toast", () => ({ default: toastMocks }));

function installPromptEvent(outcome: "accepted" | "dismissed" = "accepted") {
  return Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome, platform: "web" }),
  });
}

describe("PwaInstallPrompt", () => {
  let root: Root;
  let container: HTMLDivElement;
  let standalone = false;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    standalone = false;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(display-mode: standalone)" && standalone,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderPrompt = () => {
    act(() => root.render(<PwaInstallPrompt />));
  };

  it("captures Chrome's install event and installs only after a user click", async () => {
    renderPrompt();
    const event = installPromptEvent();

    act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(container.textContent).toContain("Android Chrome");
    expect(event.prompt).not.toHaveBeenCalled();

    const installButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "安装"
    );
    await act(async () => installButton?.click());

    expect(event.prompt).toHaveBeenCalledOnce();
    expect(toastMocks.success).toHaveBeenCalledWith("正在添加到主屏幕");
  });

  it("does not offer installation in standalone display mode", () => {
    standalone = true;
    renderPrompt();

    act(() => window.dispatchEvent(installPromptEvent()));
    expect(container.querySelector('[aria-label="安装网页播放器"]')).toBeNull();
  });

  it("clears the guide when Chrome reports appinstalled", () => {
    renderPrompt();
    act(() => window.dispatchEvent(installPromptEvent()));
    expect(container.textContent).toContain("安装网页播放器");

    act(() => window.dispatchEvent(new Event("appinstalled")));
    expect(container.textContent).not.toContain("安装网页播放器");
    expect(toastMocks.success).toHaveBeenCalledWith("网页播放器已安装");
  });

  it("falls back to Chrome's menu when the install prompt fails", async () => {
    renderPrompt();
    const event = installPromptEvent();
    event.prompt.mockRejectedValueOnce(new Error("prompt unavailable"));

    act(() => window.dispatchEvent(event));
    const installButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "安装"
    );
    await act(async () => installButton?.click());

    expect(toastMocks.error).toHaveBeenCalledWith(
      "暂时无法安装，请从 Chrome 菜单选择“添加到主屏幕”"
    );
    expect(container.textContent).not.toContain("安装网页播放器");
  });
});
