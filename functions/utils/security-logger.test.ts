// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FUNCTION_LOG_EVENTS,
  logFunctionError,
  logFunctionWarning,
} from "./security-logger";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Functions fixed-event logger", () => {
  it("logs only an approved fixed event", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logFunctionError(FUNCTION_LOG_EVENTS.MUSIC_UPSTREAM_FAILED);

    expect(error).toHaveBeenCalledWith("[functions] MUSIC_UPSTREAM_FAILED");
  });

  it.each([0, 1, 2, 3, 4])(
    "does not print an unapproved canary after %i encoding passes",
    (passes) => {
      const rawCanary = "MUSIC_U=unique-functions-log-canary";
      let canary = rawCanary;
      for (let pass = 0; pass < passes; pass += 1) {
        canary = encodeURIComponent(canary);
      }
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

      logFunctionError(canary as never);
      logFunctionWarning(`Bearer ${canary}` as never);

      const output = JSON.stringify([
        ...error.mock.calls,
        ...warning.mock.calls,
      ]);
      expect(output).not.toContain(canary);
      expect(output).not.toContain(rawCanary);
      expect(output).toContain("UNAPPROVED_FUNCTION_EVENT");
    }
  );
});
