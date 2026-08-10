import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeCustomApiOrigin,
  verifyCustomApiOrigin,
} from "@/lib/api/custom-api-origin";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("custom API origin boundary", () => {
  it("accepts only the current HTTPS origin without path, query or fragment", () => {
    const current = "https://music.example";

    expect(normalizeCustomApiOrigin(current, current)).toBe(current);
    expect(normalizeCustomApiOrigin(`${current}/`, current)).toBe(current);
    expect(normalizeCustomApiOrigin("https://api.example", current)).toBeNull();
    expect(normalizeCustomApiOrigin(`${current}/api`, current)).toBeNull();
    expect(normalizeCustomApiOrigin(`${current}?safe=1`, current)).toBeNull();
    expect(normalizeCustomApiOrigin(`${current}#section`, current)).toBeNull();
    expect(
      normalizeCustomApiOrigin("http://music.example", current)
    ).toBeNull();
  });

  it.each([
    "https://music.example?api_token=plain-canary",
    "https://music.example?note=api_token%253Ddouble-canary",
    "https://music.example?note=api_token%2525253Dfour-pass-canary",
    "https://user:password@music.example",
  ])("rejects plain, encoded and userinfo credentials: %s", (candidate) => {
    expect(
      normalizeCustomApiOrigin(candidate, "https://music.example")
    ).toBeNull();
  });

  it("allows same-origin HTTP only for local development", () => {
    expect(
      normalizeCustomApiOrigin("http://localhost:5173", "http://localhost:5173")
    ).toBe("http://localhost:5173");
    expect(
      normalizeCustomApiOrigin("http://192.0.2.10", "http://192.0.2.10")
    ).toBeNull();
  });

  it("requires the health response itself to be ok", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      verifyCustomApiOrigin("https://music.example", "https://music.example")
    ).rejects.toThrow("API_HEALTH_CHECK_FAILED");
    await expect(
      verifyCustomApiOrigin("https://music.example/", "https://music.example")
    ).resolves.toBe("https://music.example");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://music.example/health",
      expect.objectContaining({
        method: "HEAD",
        cache: "no-store",
        credentials: "same-origin",
      })
    );
  });
});
