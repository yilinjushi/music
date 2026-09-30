import { createMiddleware } from "hono/factory";
import type { Env } from "../types/hono";
import { readNeteaseSession } from "../utils/netease-session";

/** Routes reachable without an owner session: NetEase login flow only. */
const OPEN_PATHS = new Set([
  "/health",
  "/music-api/netease/login/qr/key",
  "/music-api/netease/login/qr/check",
  "/music-api/netease/login/cellphone",
  "/music-api/netease/session/me",
  "/music-api/netease/logout",
  "/music-api/netease/session/logout",
]);

// Audio playback sends many range requests; remember a verified session for a
// short while so each one does not cost a KV read.
const VERIFIED_FOR_MS = 60_000;
const verified = new Map<string, number>();

function cookieKey(cookie: string | undefined): string | null {
  const match = cookie?.match(/__Host-otter_netease_session=([^;\s]+)/);
  return match ? match[1] : null;
}

/**
 * Single-user lock: every API route except the login flow (and /cron, which
 * has its own bearer/OIDC auth; the retired /sync answers 410 to everyone) requires a session that belongs to the owner.
 */
export const ownerGate = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const path = new URL(c.req.url).pathname.replace(/\/+$/, "") || "/";
    // Static pages and assets are served by Pages; only the API is locked.
    const isApi = path.startsWith("/music-api") || path.startsWith("/proxy");
    if (
      !isApi ||
      c.req.method === "OPTIONS" ||
      OPEN_PATHS.has(path) ||
      path === "/cron" ||
      path.startsWith("/cron/")
    ) {
      await next();
      return;
    }

    const cookie = c.req.header("Cookie");
    const key = cookieKey(cookie);
    const now = Date.now();
    if (key && (verified.get(key) ?? 0) > now) {
      await next();
      return;
    }

    const ok = await readNeteaseSession(c.env, cookie)
      .then((session) => session !== null)
      .catch(() => false);
    if (!ok || !key) {
      return c.json({ error: "Unauthorized" }, 401, {
        "Cache-Control": "private, no-store, max-age=0",
      });
    }
    if (verified.size > 200) verified.clear();
    verified.set(key, now + VERIFIED_FOR_MS);
    await next();
  }
);
