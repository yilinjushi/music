// @vitest-environment node
import { describe, expect, it } from "vitest";
import { WaitUntilTracker } from "./execution-context";

describe("WaitUntilTracker", () => {
  it("captures background rejection without creating an unhandled rejection", async () => {
    const tracker = new WaitUntilTracker();
    tracker.waitUntil(Promise.reject(new Error("synthetic cache failure")));
    await tracker.drain(100);
    expect(tracker.pendingCount).toBe(0);
    expect(tracker.rejectedCount).toBe(1);
  });
});
