import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncMediaSessionPosition } from "./media-session";

describe("syncMediaSessionPosition", () => {
  const setPositionState = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: { setPositionState },
    });
  });

  it("clears stale state instead of sending a non-positive duration", () => {
    expect(
      syncMediaSessionPosition({
        duration: 0,
        currentTime: 0,
        playbackRate: 1,
      })
    ).toBe(false);
    expect(setPositionState).toHaveBeenCalledWith();
  });

  it("uses a positive playback rate and clamps position to duration", () => {
    expect(
      syncMediaSessionPosition({
        duration: 100,
        currentTime: 150,
        playbackRate: 0,
      })
    ).toBe(true);
    expect(setPositionState).toHaveBeenCalledWith({
      duration: 100,
      playbackRate: 1,
      position: 100,
    });
  });

  it("clamps a negative or non-finite position to zero", () => {
    syncMediaSessionPosition({
      duration: 100,
      currentTime: Number.NaN,
      playbackRate: 1.25,
    });
    expect(setPositionState).toHaveBeenCalledWith({
      duration: 100,
      playbackRate: 1.25,
      position: 0,
    });
  });
});
