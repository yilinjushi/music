import { Hono } from "hono";
import type { Env } from "../types/hono";
import { readNeteaseSessionById } from "../utils/netease-session";
import { AUDIO_CACHE_CRON_TARGET_KEY, resolveAudioCache } from "./music";

export const cronRoutes = new Hono<{ Bindings: Env }>();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Scheduled audio-cache sync (GitHub Actions calls this every few minutes).
 * Authenticated with the CRON_SECRET bearer token; acts on the session and
 * playlist the owner's app last registered via /music-api/cache/netease-playlist-sync.
 */
cronRoutes.post("/audio-cache", async (c) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  const secret = c.env.CRON_SECRET?.trim();
  const provided = (c.req.header("Authorization") || "").replace(
    /^Bearer\s+/i,
    ""
  );
  if (!secret || secret.length < 16 || !timingSafeEqual(provided, secret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const cache = resolveAudioCache(c);
  if (!cache) return c.json({ error: "Audio cache unavailable" }, 404);

  const target = (await c.env.oh_file_url.get(AUDIO_CACHE_CRON_TARGET_KEY, {
    type: "json",
  })) as { sessionId?: unknown; playlistId?: unknown } | null;
  if (
    !target ||
    typeof target.sessionId !== "string" ||
    typeof target.playlistId !== "string"
  ) {
    return c.json({ state: "idle", reason: "no target yet" });
  }
  try {
    const session = await readNeteaseSessionById(c.env, target.sessionId);
    if (!session) return c.json({ state: "idle", reason: "session expired" });
    const result = await cache.syncNeteasePlaylist(
      target.playlistId,
      session.credential
    );
    return c.json({
      state: "ok",
      ...result,
      unavailable: result.unavailable.length,
    });
  } catch {
    return c.json({ error: "Sync failed" }, 502);
  }
});
