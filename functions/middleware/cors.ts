import { createMiddleware } from "hono/factory";
import type { Env } from "../types/hono";
import {
  parseConfiguredAppOrigin,
  parseRequestOrigin,
} from "../utils/app-origin";

const ALLOWED_METHODS = "GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH";
const ALLOWED_HEADERS =
  "Content-Type, Authorization, Range, If-Range, X-CSRF-Token";
const EXPOSED_HEADERS = "Content-Length, Content-Range, Accept-Ranges, ETag";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isAllowedRequestOrigin(
  requestUrl: string,
  requestOrigin: string | undefined,
  configuredOrigin?: string
): boolean {
  const configured = parseConfiguredAppOrigin(configuredOrigin);
  if (!configured) return false;

  const origin = parseRequestOrigin(requestOrigin);
  if (!origin) return false;

  const sameOrigin = new URL(requestUrl).origin;
  if (origin === sameOrigin) return true;

  return origin === configured;
}

/**
 * Credentialed CORS must never reflect an arbitrary Origin. Same-origin
 * requests normally need no CORS headers; an explicitly configured preview
 * origin may be allowed for development/deployment verification.
 */
export const corsMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const configuredOrigin = parseConfiguredAppOrigin(c.env.APP_ORIGIN);
    if (!configuredOrigin) {
      return c.json(
        { success: false, message: "Service origin is not configured" },
        503
      );
    }

    const origin = c.req.header("Origin");
    const allowed = isAllowedRequestOrigin(c.req.url, origin, configuredOrigin);
    const method = c.req.method.toUpperCase();
    const hasCredentialCookie = Boolean(c.req.header("Cookie"));
    const fetchSite = c.req.header("Sec-Fetch-Site");

    if (fetchSite === "cross-site" && UNSAFE_METHODS.has(method)) {
      return c.json(
        { success: false, message: "Cross-site request denied" },
        403
      );
    }

    if (origin && !allowed) {
      return c.json({ success: false, message: "Origin not allowed" }, 403);
    }

    // A credentialed unsafe browser request without Origin cannot be
    // distinguished from CSRF. Non-browser/server requests without cookies
    // remain available for health checks and public APIs.
    if (UNSAFE_METHODS.has(method) && hasCredentialCookie && !origin) {
      return c.json({ success: false, message: "Origin required" }, 403);
    }

    if (method === "OPTIONS") {
      if (!origin || !allowed) {
        return c.body(null, 403);
      }
      c.header("Access-Control-Allow-Origin", parseRequestOrigin(origin)!);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Allow-Methods", ALLOWED_METHODS);
      c.header("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      c.header("Access-Control-Max-Age", "86400");
      c.header("Vary", "Origin");
      return c.body(null, 204);
    }

    await next();

    if (origin && allowed) {
      c.header("Access-Control-Allow-Origin", parseRequestOrigin(origin)!);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Expose-Headers", EXPOSED_HEADERS);
      c.header("Vary", "Origin", { append: true });
    }
  }
);
