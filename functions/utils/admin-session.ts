import type { Env, KVNamespace } from "../types/hono";

export type AdminEnv = Env & {
  ADMIN_SESSION_SECRET?: string;
};

export const ADMIN_COOKIE_NAME = "__Host-music_admin";
export const DEV_ADMIN_COOKIE_NAME = "music_admin";

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_FAILURES = 5;

type RateRecord = { failures: number; resetAt: number };

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

export function getAdminToken(cookieHeader: string | undefined): string | null {
  return (
    parseCookie(cookieHeader, ADMIN_COOKIE_NAME) ||
    parseCookie(cookieHeader, DEV_ADMIN_COOKIE_NAME)
  );
}

export function buildAdminCookie(
  token: string,
  secure: boolean,
  maxAgeSeconds: number
): string {
  const name = secure ? ADMIN_COOKIE_NAME : DEV_ADMIN_COOKIE_NAME;
  return [
    `${name}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function hasAdminConfiguration(
  env: AdminEnv
): env is AdminEnv & { PASSWORD: string; ADMIN_SESSION_SECRET: string } {
  return Boolean(
    env.PASSWORD &&
    env.PASSWORD.length >= 12 &&
    env.ADMIN_SESSION_SECRET &&
    env.ADMIN_SESSION_SECRET.length >= 32 &&
    env.ADMIN_SESSION_SECRET !== env.PASSWORD
  );
}

export async function constantTimeEqual(
  candidate: string,
  expected: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(candidateHash);
  const right = new Uint8Array(expectedHash);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

async function rateKey(clientId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(clientId || "unknown")
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `admin-login-rate:${hash}`;
}

async function readRateRecord(
  kv: KVNamespace,
  key: string
): Promise<RateRecord | null> {
  const raw = await kv.get(key, { type: "json" });
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<RateRecord>;
  if (
    typeof record.failures !== "number" ||
    typeof record.resetAt !== "number"
  ) {
    return null;
  }
  return { failures: record.failures, resetAt: record.resetAt };
}

export async function isLoginRateLimited(
  kv: KVNamespace,
  clientId: string,
  now = Date.now()
): Promise<boolean> {
  const record = await readRateRecord(kv, await rateKey(clientId));
  return Boolean(
    record && record.resetAt > now && record.failures >= RATE_MAX_FAILURES
  );
}

export async function recordLoginFailure(
  kv: KVNamespace,
  clientId: string,
  now = Date.now()
): Promise<void> {
  const key = await rateKey(clientId);
  const current = await readRateRecord(kv, key);
  const active = current && current.resetAt > now;
  const record: RateRecord = {
    failures: active ? current.failures + 1 : 1,
    resetAt: active ? current.resetAt : now + RATE_WINDOW_MS,
  };
  await kv.put(key, JSON.stringify(record), {
    expirationTtl: Math.ceil(RATE_WINDOW_MS / 1000),
  });
}

export async function clearLoginFailures(
  kv: KVNamespace,
  clientId: string
): Promise<void> {
  await kv.delete(await rateKey(clientId));
}
