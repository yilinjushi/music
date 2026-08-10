import { corsMiddleware } from "./middleware/cors";
import { proxyRoutes } from "./routes/proxy";
import { musicRoutes } from "./routes/music";
import { syncRoutes } from "./routes/sync";
import { syncRoutesV2 } from "./routes/sync-v2";

import { Hono, type Context } from "hono";
import type { Env } from "./types/hono";
import { FUNCTION_LOG_EVENTS, logFunctionError } from "./utils/security-logger";

export const app = new Hono<{
  Bindings: Env;
}>();

export function handleUnhandledFunctionError(
  _error: Error,
  c: Context<{ Bindings: Env }>
) {
  logFunctionError(FUNCTION_LOG_EVENTS.UNHANDLED_FUNCTION_ERROR);
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  return c.json({ error: "Internal server error" }, 500);
}

app.onError(handleUnhandledFunctionError);

app.use("*", corsMiddleware);
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  );
  c.header("X-Frame-Options", "DENY");
  if (new URL(c.req.url).protocol === "https:") {
    c.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }
});

app.get("/health", (c) => c.text("OK"));
app.on("HEAD", "/health", (c) => c.body(null, 200));

// Routes
app.route("/proxy", proxyRoutes);
app.route("/music-api", musicRoutes);
app.route("/sync", syncRoutes);
app.route("/sync/v2", syncRoutesV2);

// Export AppType for RPC
export type AppType = typeof app;
