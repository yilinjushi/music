import { describe, expect, it, vi } from "vitest";
import { retry } from "./index";

describe("retry", () => {
  it("rethrows AbortError immediately without retrying or waiting", async () => {
    vi.useFakeTimers();
    const aborted = new DOMException("Aborted", "AbortError");
    const operation = vi.fn().mockRejectedValue(aborted);

    const request = retry(operation, 2, 800);
    await expect(request).rejects.toBe(aborted);
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
