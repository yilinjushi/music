// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/request-rate-limit", () => ({
  checkFixedWindowRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 119,
    retryAfterSeconds: 0,
  }),
  requestClientId: vi.fn().mockReturnValue("integration-client"),
}));

import { bilibiliRoutes } from "./bilibili";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Bilibili DASH to durl integration", () => {
  it("tries a real-shape native durl only after the bounded DASH set fails", async () => {
    const primary =
      "https://upos-sz-mirrorcos.bilivideo.com/primary.m4s?deadline=1";
    const backupOne =
      "https://upos-sz-mirrorali.bilivideo.com/backup-1.m4s?deadline=1";
    const backupTwo =
      "https://upos-sz-mirrorhw.bilivideo.com/backup-2.m4s?deadline=1";
    const ignoredDash =
      "https://upos-sz-mirror08c.bilivideo.com/not-attempted.m4s?deadline=1";
    const fallback =
      "https://upos-sz-mirrorcos.bilivideo.com/native-fallback.mp4?deadline=1";
    const requested: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("api.bilibili.com") && url.includes("fnval=16")) {
          return Promise.resolve(
            Response.json({
              code: 0,
              message: "0",
              ttl: 1,
              data: {
                from: "local",
                quality: 80,
                dash: {
                  audio: [
                    {
                      id: 30280,
                      base_url: primary,
                      backup_url: [backupOne, backupTwo, ignoredDash],
                      bandwidth: 30280,
                      mime_type: "audio/mp4",
                      codecs: "mp4a.40.2",
                    },
                  ],
                },
              },
            })
          );
        }
        if (url.includes("api.bilibili.com") && url.includes("fnval=0")) {
          return Promise.resolve(
            Response.json({
              code: 0,
              message: "0",
              ttl: 1,
              data: {
                from: "local",
                result: "suee",
                quality: 80,
                format: "mp4",
                durl: [
                  {
                    order: 1,
                    length: 182000,
                    size: 728000,
                    ahead: "",
                    vhead: "",
                    url: fallback,
                    backup_url: [
                      "https://upos-sz-mirrorali.bilivideo.com/rejected.flv",
                    ],
                  },
                ],
              },
            })
          );
        }
        if (url === fallback) {
          return Promise.resolve(
            new Response("native durl audio", {
              headers: {
                "Content-Type": "audio/mp4",
                "Content-Length": "17",
              },
            })
          );
        }
        if ([primary, backupOne, backupTwo].includes(url)) {
          return Promise.resolve(
            Response.json({ code: -404, message: "expired capability" })
          );
        }
        return Promise.reject(new Error(`unexpected upstream: ${url}`));
      })
    );

    const response = await bilibiliRoutes.request(
      "/audio?bvid=BV1xx411c7mD&cid=2164311",
      undefined,
      { oh_file_url: {} } as never
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mp4");
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("native durl audio");
    expect(requested).toEqual([
      expect.stringContaining("fnval=16"),
      primary,
      backupOne,
      backupTwo,
      expect.stringContaining("fnval=0"),
      fallback,
    ]);
    expect(requested).not.toContain(ignoredDash);
    expect(requested.some((url) => url.endsWith(".flv"))).toBe(false);
  });
});
