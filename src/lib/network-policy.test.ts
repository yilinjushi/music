import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canUseNetwork,
  isLocalOnly,
  setManualLocalOnly,
} from "@/lib/network-policy";

function setConnection(type: string | undefined) {
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: type ? { type } : undefined,
  });
}

describe("network policy", () => {
  afterEach(() => {
    setManualLocalOnly(false);
    setConnection(undefined);
    vi.restoreAllMocks();
  });

  it("allows the network on an ordinary online connection", () => {
    expect(isLocalOnly()).toBe(false);
    expect(canUseNetwork()).toBe(true);
  });

  it("blocks the network on a cellular connection", () => {
    setConnection("cellular");
    expect(isLocalOnly()).toBe(true);
    expect(canUseNetwork()).toBe(false);
  });

  it("keeps the network on wifi", () => {
    setConnection("wifi");
    expect(canUseNetwork()).toBe(true);
  });

  it("blocks the network when local-only is switched on by hand", () => {
    setManualLocalOnly(true);
    expect(localStorage.getItem("music_local_only")).toBe("1");
    expect(canUseNetwork()).toBe(false);
    setManualLocalOnly(false);
    expect(localStorage.getItem("music_local_only")).toBeNull();
    expect(canUseNetwork()).toBe(true);
  });

  it("blocks the network while offline", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(canUseNetwork()).toBe(false);
  });
});
