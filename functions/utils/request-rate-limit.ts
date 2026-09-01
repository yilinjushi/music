import type { KVNamespace } from "../types/hono";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

// KV read/modify/write is not atomic. Serialize identical keys inside an
// isolate so a burst handled by the same worker cannot have every request read
// the same stale count. A deployment-level atomic rate limiter is still the
// required outer guard across isolates/regions.
const rateLimitKeyTails = new Map<string, Promise<void>>();

async function withRateLimitKeyLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = rateLimitKeyTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  rateLimitKeyTails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (rateLimitKeyTails.get(key) === tail) rateLimitKeyTails.delete(key);
  }
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
 * Small fixed-window guard suitable for a private Pages deployment. KV is not
 * a globally atomic counter, so platform-level rate limiting remains the
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
  if (kv.consumeFixedWindow) {
    const result = await kv.consumeFixedWindow(
      key,
      limit,
      Math.max(60, windowSeconds * 2),
      now
    );
    return {
      allowed: result.allowed,
      retryAfterSeconds,
      remaining: Math.max(0, limit - result.count),
    };
  }

  return withRateLimitKeyLock(key, async () => {
    const raw = await kv.get(key);
    const parsed = Number.parseInt(typeof raw === "string" ? raw : "0", 10);
    const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

    if (count >= limit) {
      return { allowed: false, retryAfterSeconds, remaining: 0 };
    }

    await kv.put(key, String(count + 1), {
      expirationTtl: Math.max(60, windowSeconds * 2),
    });
    return {
      allowed: true,
      retryAfterSeconds,
      remaining: Math.max(0, limit - count - 1),
    };
  });
}
