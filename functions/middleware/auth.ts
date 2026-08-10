import { createMiddleware } from "hono/factory";
import { verifyJWT } from "@utils/auth";
import type { Env } from "../types/hono";
import { fail } from "@utils/response";
import {
  getAdminToken,
  hasAdminConfiguration,
  type AdminEnv,
} from "@utils/admin-session";

const PUBLIC_PATHS = [
  /^\/$/,
  /^\/auth\/login$/,
  /^\/_next\//,
  /\.(ico|png|svg|jpg|jpeg|css|js|webmanifest|json|woff|woff2|ttf|eot)$/,
];

export const authMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_PATHS.some((pattern) => pattern.test(path))) {
      await next();
      return;
    }

    const env = c.env as AdminEnv;
    if (!hasAdminConfiguration(env)) {
      return fail(c, "Admin authentication is not configured", 503);
    }

    const authToken = getAdminToken(c.req.header("Cookie"));
    if (!authToken) {
      return fail(c, "Unauthorized", 401);
    }

    try {
      await verifyJWT(authToken, env.ADMIN_SESSION_SECRET);
      await next();
    } catch {
      return fail(c, "Unauthorized", 401);
    }
  }
);
