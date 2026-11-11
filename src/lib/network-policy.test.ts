import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canUseNetwork,
  isLocalOnly,
  setManualLocalOnly,
} from "@/lib/network-policy";

describe("network policy", () => {
  afterEach(() => {
    setManualLocalOnly(false);
    vi.restoreAllMocks();
  });

  it("allows the network in online mode", () => {
    expect(isLocalOnly()).toBe(false);
    expect(canUseNetwork()).toBe(true);
  });

  it("blocks the network in offline mode", () => {
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
