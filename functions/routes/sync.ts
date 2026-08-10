import { Hono, type Context } from "hono";
import type { Env } from "../types/hono";
import { fail } from "@utils/response";

/**
 * Legacy v1 sync is retired for the same reason as v2: Cloudflare KV does not
 * provide the atomic primitive required for a lossless read/merge/write
 * protocol. Keep the route as an explicit, private 410 so old clients fail
 * closed instead of retrying or silently overwriting remote state.
 */
export const syncRoutes = new Hono<{ Bindings: Env }>();

function retiredSync(c: Context) {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("Vary", "Authorization", { append: true });
  c.header("Vary", "Cookie", { append: true });
  return fail(c, "Remote sync is retired", 410);
}

syncRoutes.all("*", retiredSync);
