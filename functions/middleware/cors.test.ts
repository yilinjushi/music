import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { corsMiddleware } from "./cors";

function makeApp() {
  const app = new Hono();
  app.use("*", corsMiddleware as never);
  app.all("/api", (c) => c.json({ ok: true }));
  return app;
}

const env = {
  APP_ORIGIN: "https://music.example",
  oh_file_url: {},
};

describe("credentialed CORS policy", () => {
  it.each([
    undefined,
    "http://music.example",
    "https://music.example/",
    "https://music.example/path",
    "https://music.example?preview=1",
    " https://music.example",
  ])(
    "fails closed when APP_ORIGIN is not an exact HTTPS origin: %s",
    async (value) => {
      const response = await makeApp().request(
        "https://api.music.example/api",
        { method: "GET" },
        { ...env, APP_ORIGIN: value } as never
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  );

  it("allows the exact application origin", async () => {
    const response = await makeApp().request(
      "https://api.music.example/api",
      {
        method: "POST",
        headers: { Origin: "https://music.example" },
      },
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://music.example"
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true"
    );
  });

  it("rejects an arbitrary Origin instead of reflecting it", async () => {
    const response = await makeApp().request(
      "https://api.music.example/api",
      {
        method: "POST",
        headers: { Origin: "https://attacker.example" },
      },
      env
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects an unsafe credentialed request with no Origin", async () => {
    const response = await makeApp().request(
      "https://api.music.example/api",
      { method: "POST", headers: { Cookie: "session=opaque" } },
      env
    );
    expect(response.status).toBe(403);
  });

  it("answers an approved preflight without a wildcard", async () => {
    const response = await makeApp().request(
      "https://api.music.example/api",
      {
        method: "OPTIONS",
        headers: { Origin: "https://music.example" },
      },
      env
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://music.example"
    );
  });
});
