// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "./types/hono";
import { handleUnhandledFunctionError } from "./app";

afterEach(() => vi.restoreAllMocks());

describe("Functions top-level error boundary", () => {
  it("drops child-route errors and request canaries", async () => {
    const canary = "MUSIC_U=malformed-request-canary";
    const boundaryApp = new Hono<{ Bindings: Env }>();
    boundaryApp.onError(handleUnhandledFunctionError);
    boundaryApp.get("/child", () => {
      throw new Error(canary);
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const response = await boundaryApp.request("/child", undefined, {
      APP_ORIGIN: "https://music.example",
    } as Env);
    const text = await response.text();
    const logged = JSON.stringify(consoleError.mock.calls);

    expect(response.status).toBe(500);
    expect(text).toBe('{"error":"Internal server error"}');
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(text).not.toContain(canary);
    expect(logged).toBe('[["[functions] UNHANDLED_FUNCTION_ERROR"]]');
    expect(logged).not.toContain(canary);
  });
});
