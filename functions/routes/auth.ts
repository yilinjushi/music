import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { signJWT } from "@utils/auth";
import type { Env } from "../types/hono";
import { fail, ok } from "@utils/response";
import {
  buildAdminCookie,
  clearLoginFailures,
  constantTimeEqual,
  hasAdminConfiguration,
  isLoginRateLimited,
  recordLoginFailure,
  type AdminEnv,
} from "@utils/admin-session";

export const authRoutes = new Hono<{ Bindings: Env }>();

const loginSchema = z.object({
  password: z.string().min(1).max(256),
});

function clientIdentifier(headers: Headers): string {
  return (
    headers.get("CF-Connecting-IP") ||
    headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

authRoutes.post("/login", zValidator("json", loginSchema), async (c) => {
  const env = c.env as AdminEnv;
  if (!hasAdminConfiguration(env)) {
    return fail(c, "Admin authentication is not configured", 503);
  }

  const clientId = clientIdentifier(c.req.raw.headers);
  if (await isLoginRateLimited(env.oh_file_url, clientId)) {
    c.header("Retry-After", "600");
    return fail(c, "Too many login attempts", 429);
  }

  const { password } = c.req.valid("json");
  if (!(await constantTimeEqual(password, env.PASSWORD))) {
    await recordLoginFailure(env.oh_file_url, clientId);
    return fail(c, "Unauthorized", 401);
  }

  await clearLoginFailures(env.oh_file_url, clientId);
  const token = await signJWT(env.ADMIN_SESSION_SECRET, "1d");
  const isSecure = new URL(c.req.url).protocol === "https:";
  c.header("Set-Cookie", buildAdminCookie(token, isSecure, 86400));
  c.header("Cache-Control", "no-store");
  return ok(c, null, "Login successful", 200);
});

authRoutes.post("/logout", (c) => {
  const isSecure = new URL(c.req.url).protocol === "https:";
  c.header("Set-Cookie", buildAdminCookie("", isSecure, 0));
  c.header("Cache-Control", "no-store");
  return ok(c, null, "Logout successful", 200);
});
