import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistStorage, StorageValue } from "zustand/middleware";

vi.mock("@/lib/storage-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage-adapter")>()),
  idbStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

const { createThrottledPersistStorage } = await import("./index");

function fakeInner() {
  return {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  } satisfies PersistStorage<number>;
}

const value = (state: number): StorageValue<number> => ({ state, version: 1 });

describe("createThrottledPersistStorage", () => {
  afterEach(() => vi.useRealTimers());

  it("writes only the latest value once per delay", () => {
    vi.useFakeTimers();
    const inner = fakeInner();
    const storage = createThrottledPersistStorage(inner, 5_000);

    for (let i = 1; i <= 5; i++) storage.setItem("k", value(i));
    expect(inner.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(inner.setItem).toHaveBeenCalledTimes(1);
    expect(inner.setItem).toHaveBeenCalledWith("k", value(5));
  });

  it("flushes pending writes when the page is hidden", () => {
    vi.useFakeTimers();
    const inner = fakeInner();
    const storage = createThrottledPersistStorage(inner, 5_000);
    storage.setItem("k", value(7));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

    expect(inner.setItem).toHaveBeenCalledWith("k", value(7));
    vi.advanceTimersByTime(5_000);
    expect(inner.setItem).toHaveBeenCalledTimes(1);
  });

  it("never writes while hidden and saves once on return", () => {
    vi.useFakeTimers();
    const inner = fakeInner();
    const storage = createThrottledPersistStorage(inner, 5_000);
    const setVisibility = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };

    setVisibility("hidden");
    for (let i = 1; i <= 3; i++) storage.setItem("k", value(i));
    vi.advanceTimersByTime(60_000);
    expect(inner.setItem).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(inner.setItem).toHaveBeenCalledTimes(1);
    expect(inner.setItem).toHaveBeenCalledWith("k", value(3));
  });
});
