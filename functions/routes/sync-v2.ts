import { Hono, type Context } from "hono";
import type { Env } from "../types/hono";
import { fail } from "@utils/response";

/**
 * Remote sync is intentionally retired.
 *
 * The configured Cloudflare KV binding exposes no compare-and-swap,
 * transaction, or Durable Object coordinator. Read/check/write and branch
 * compaction protocols therefore cannot guarantee that concurrent clients do
 * not lose an update. Returning a fixed 410 without touching KV is safer than
 * presenting eventually-consistent storage as an atomic sync service.
 */
export const syncRoutesV2 = new Hono<{ Bindings: Env }>();

function retiredSync(c: Context) {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("Vary", "Authorization", { append: true });
  c.header("Vary", "Cookie", { append: true });
  return fail(c, "Remote sync is retired", 410);
}

syncRoutesV2.all("*", retiredSync);
