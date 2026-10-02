import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMusicStore } from "@/store/music-store";
import { PwaUpdatePrompt } from "./PwaUpdatePrompt";

const pwaMocks = vi.hoisted(() => ({
  setNeedRefresh: vi.fn(),
  setOfflineReady: vi.fn(),
  updateServiceWorker: vi.fn().mockResolvedValue(undefined),
  needRefresh: true,
  offlineReady: false,
}));

vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: () => ({
    needRefresh: [pwaMocks.needRefresh, pwaMocks.setNeedRefresh],
    offlineReady: [pwaMocks.offlineReady, pwaMocks.setOfflineReady],
    updateServiceWorker: pwaMocks.updateServiceWorker,
  }),
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn() },
}));

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

describe("PwaUpdatePrompt", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    pwaMocks.needRefresh = true;
    pwaMocks.offlineReady = false;
    useMusicStore.setState({ isPlaying: false });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderPrompt = () => {
    act(() => root.render(<PwaUpdatePrompt />));
  };

  it("waits for an explicit user action before applying an update", async () => {
    renderPrompt();

    const prompt = container.querySelector(
      '[aria-label="播放器更新"]'
    ) as HTMLElement;
    expect(prompt.className).toContain("pointer-events-auto");
    expect(prompt.className).toContain(
      "bottom-[calc(var(--bottom-stack-height)+12px)]"
    );
    expect(prompt.className).toContain("z-40");
    expect(prompt.className).not.toContain("z-[100]");

    const updateButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("更新")
    );
    expect(updateButton).toBeDefined();
    expect(pwaMocks.updateServiceWorker).not.toHaveBeenCalled();

    await act(async () => {
      updateButton?.click();
      await Promise.resolve();
    });
    expect(pwaMocks.updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("lets the user dismiss the update prompt", () => {
    renderPrompt();

    const dismissButton = container.querySelector(
      'button[aria-label="稍后更新"]'
    ) as HTMLButtonElement;
    expect(dismissButton.className).toContain("pointer-events-auto");

    act(() => dismissButton.click());
    expect(pwaMocks.setNeedRefresh).toHaveBeenCalledWith(false);
  });

  it("messages the root waiting worker directly before falling back", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker"
    );
    const waiting = { postMessage: vi.fn() };
    const serviceWorker = {
      getRegistration: vi.fn().mockResolvedValue({ waiting }),
      addEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    });

    try {
      renderPrompt();
      const updateButton = Array.from(
        container.querySelectorAll("button")
      ).find((button) => button.textContent?.includes("更新"));
      await act(async () => {
        updateButton?.click();
        await Promise.resolve();
      });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(navigator, "serviceWorker", originalDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "serviceWorker");
      }
    }

    expect(serviceWorker.getRegistration).toHaveBeenCalledOnce();
    expect(serviceWorker.addEventListener).toHaveBeenCalledWith(
      "controllerchange",
      expect.any(Function),
      { once: true }
    );
    expect(waiting.postMessage).toHaveBeenCalledWith({
      type: "SKIP_WAITING",
    });
    expect(pwaMocks.updateServiceWorker).not.toHaveBeenCalled();
  });

  it("does not allow a service-worker reload while music is playing", () => {
    useMusicStore.setState({ isPlaying: true });
    renderPrompt();

    const updateButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("更新")
    ) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);

    act(() => updateButton.click());
    expect(pwaMocks.updateServiceWorker).not.toHaveBeenCalled();
  });

  it("waits for the real media pause event before enabling an update", async () => {
    const audio = document.createElement("audio");
    let paused = false;
    Object.defineProperty(audio, "paused", {
      configurable: true,
      get: () => paused,
    });
    document.body.appendChild(audio);

    renderPrompt();
    const updateButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("更新")
    ) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);

    await act(async () => {
      updateButton.click();
      await Promise.resolve();
    });
    expect(pwaMocks.updateServiceWorker).not.toHaveBeenCalled();

    await act(async () => {
      paused = true;
      audio.dispatchEvent(new Event("pause"));
      await Promise.resolve();
    });
    // Update now applies automatically once playback is idle.
    expect(pwaMocks.updateServiceWorker).toHaveBeenCalledWith(true);
    audio.remove();
  });
});
