import { describe, expect, it } from "vitest";
import { validateAndParse } from "./text-playlist-import";

describe("text playlist sensitive ingress", () => {
  it("rejects nested triple-encoded sensitive assignments", () => {
    const result = validateAndParse(
      JSON.stringify({
        name: "Imported",
        tracks: [
          {
            name: "Song",
            artist: ["Artist"],
            extra: "authorization%25253ABearer%252520canary",
          },
        ],
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        valid: false,
        error: expect.stringMatching(/敏感/),
      })
    );
  });

  it("parses a safe structured import larger than 128 KiB", () => {
    const raw = JSON.stringify({
      name: "Large import",
      tracks: Array.from({ length: 600 }, (_, index) => ({
        name: `Song ${index} ${"melody ".repeat(30)}`,
        artist: ["Artist"],
      })),
    });
    expect(new Blob([raw]).size).toBeGreaterThan(128 * 1024);

    const result = validateAndParse(raw);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data.tracks).toHaveLength(600);
  });
});
