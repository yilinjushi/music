import type { KVNamespace } from "../types/hono";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

// Counters live in isolate memory instead of KV: every media range request
// hits this guard, and KV's free tier allows only 1,000 writes per day. The
// trade-off is that each isolate counts separately, which is acceptable for a
// private deployment. Counters are grouped per binding object so separate
// environments (and tests) never share state.
const counterStores = new WeakMap<
  object,
  Map<string, { count: number; expiresAt: number }>
>();
const MAX_TRACKED_KEYS = 5000;

function counterStore(owner: object) {
  let store = counterStores.get(owner);
  if (!store) {
    store = new Map();
    counterStores.set(owner, store);
  }
  return store;
}

function pruneExpired(
  store: Map<string, { count: number; expiresAt: number }>,
  now: number
) {
  if (store.size < MAX_TRACKED_KEYS) return;
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  if (store.size >= MAX_TRACKED_KEYS) store.clear();
}

async function digestIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value || "unknown")
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function requestClientId(headers: Headers): string {
  // Cloudflare owns CF-Connecting-IP. Deliberately do not trust a caller-
  // supplied X-Forwarded-For value for abuse controls.
  return headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

/**
 * Small fixed-window guard suitable for a private Pages deployment. Counters
 * are per isolate (see above), so platform-level rate limiting remains the
 * recommended production outer layer; this guard still fails closed and
 * prevents accidental exposure as an unrestricted media relay.
 */
export async function checkFixedWindowRateLimit(
  kv: KVNamespace,
  scope: string,
  clientId: string,
  limit: number,
  windowSeconds: number,
  now = Date.now()
): Promise<RateLimitResult> {
  if (limit < 1 || windowSeconds < 1) {
    throw new Error("Invalid rate-limit configuration");
  }

  const windowMs = windowSeconds * 1000;
  const windowIndex = Math.floor(now / windowMs);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(((windowIndex + 1) * windowMs - now) / 1000)
  );
  const identifier = await digestIdentifier(clientId);
  const key = `request-rate:v1:${scope}:${windowIndex}:${identifier}`;
  // The binding only anchors the counter store, but a missing binding still
  // means a misconfigured deployment, so keep failing closed.
  if (!kv) throw new Error("Rate-limit binding unavailable");
  const store = counterStore(kv);
  pruneExpired(store, now);
  const entry = store.get(key);
  const count = entry && entry.expiresAt > now ? entry.count : 0;

  if (count >= limit) {
    return { allowed: false, retryAfterSeconds, remaining: 0 };
  }

  store.set(key, { count: count + 1, expiresAt: (windowIndex + 1) * windowMs });
  return {
    allowed: true,
    retryAfterSeconds,
    remaining: Math.max(0, limit - count - 1),
  };
}
