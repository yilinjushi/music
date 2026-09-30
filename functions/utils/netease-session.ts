import type { UserProfile } from "./music/netease-types";
import type { Env } from "../types/hono";
import { isOwnerUserId } from "./owner";

export const NETEASE_SESSION_COOKIE = "__Host-otter_netease_session";

const SESSION_KEY_PREFIX = "netease-session:v1:";
// Chrome caps cookie lifetime at 400 days.
const DEFAULT_SESSION_TTL_SECONDS = 400 * 24 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 60 * 60;
const MAX_SESSION_TTL_SECONDS = 400 * 24 * 60 * 60;
const SESSION_RENEW_AFTER_SECONDS = 24 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface EncryptedCredential {
  iv: string;
  ciphertext: string;
}

interface StoredNeteaseSession {
  version: 1;
  credential: EncryptedCredential;
  profile: UserProfile;
  createdAt: number;
  expiresAt: number;
}

export interface NeteaseSession {
  id: string;
  credential: string;
  profile: UserProfile;
  expiresAt: number;
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value || value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
  return value;
}

function requireIndependentSecrets(env: Env): {
  hmacSecret: string;
  encryptionSecret: string;
} {
  const hmacSecret = requireSecret(
    env.NETEASE_SESSION_HMAC_SECRET,
    "NETEASE_SESSION_HMAC_SECRET"
  );
  const encryptionSecret = requireSecret(
    env.NETEASE_CREDENTIAL_ENC_KEY,
    "NETEASE_CREDENTIAL_ENC_KEY"
  );
  if (hmacSecret === encryptionSecret) {
    throw new Error("NetEase session secrets must be different");
  }
  return { hmacSecret, encryptionSecret };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signSessionId(id: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(id)
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifySessionToken(
  token: string,
  secret: string
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [id, encodedSignature] = parts;
  if (!/^[A-Za-z0-9_-]{32,}$/.test(id)) return null;
  const signature = base64UrlToBytes(encodedSignature);
  if (!signature) return null;

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    toArrayBuffer(signature),
    encoder.encode(id)
  );
  return valid ? id : null;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptCredential(
  credential: string,
  secret: string
): Promise<EncryptedCredential> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(secret),
    encoder.encode(credential)
  );
  return {
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

async function decryptCredential(
  encrypted: EncryptedCredential,
  secret: string
): Promise<string> {
  const iv = base64UrlToBytes(encrypted.iv);
  const ciphertext = base64UrlToBytes(encrypted.ciphertext);
  if (!iv || iv.length !== 12 || !ciphertext) {
    throw new Error("Invalid encrypted credential");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    await aesKey(secret),
    toArrayBuffer(ciphertext)
  );
  return decoder.decode(plaintext);
}

function getSessionTtl(env: Env): number {
  const configured = Number.parseInt(env.NETEASE_SESSION_TTL_SECONDS || "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_SESSION_TTL_SECONDS;
  return Math.min(
    MAX_SESSION_TTL_SECONDS,
    Math.max(MIN_SESSION_TTL_SECONDS, configured)
  );
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function sessionKey(id: string): string {
  return `${SESSION_KEY_PREFIX}${id}`;
}

export function serializeSessionCookie(token: string, maxAge: number): string {
  return [
    `${NETEASE_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function serializeExpiredSessionCookie(): string {
  return [
    `${NETEASE_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=0",
  ].join("; ");
}

export async function createNeteaseSession(
  env: Env,
  credential: string,
  profile: UserProfile,
  now = Date.now()
): Promise<{ token: string; maxAge: number }> {
  const { hmacSecret, encryptionSecret } = requireIndependentSecrets(env);
  if (!credential || !/(?:^|;\s*)MUSIC_U=/.test(credential)) {
    throw new Error("NetEase credential is missing MUSIC_U");
  }

  const maxAge = getSessionTtl(env);
  const id = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const record: StoredNeteaseSession = {
    version: 1,
    credential: await encryptCredential(credential, encryptionSecret),
    profile,
    createdAt: now,
    expiresAt: now + maxAge * 1000,
  };

  await env.SESSION_KV.put(sessionKey(id), JSON.stringify(record), {
    expirationTtl: maxAge,
  });

  const signature = await signSessionId(id, hmacSecret);
  return { token: `${id}.${signature}`, maxAge };
}

export async function readNeteaseSession(
  env: Env,
  cookieHeader: string | undefined,
  now = Date.now()
): Promise<NeteaseSession | null> {
  const { hmacSecret } = requireIndependentSecrets(env);
  const token = parseCookie(cookieHeader, NETEASE_SESSION_COOKIE);
  if (!token) return null;

  const id = await verifySessionToken(token, hmacSecret);
  if (!id) return null;
  return readNeteaseSessionById(env, id, now);
}

/**
 * Server-side lookup by session id, for trusted background work (the audio
 * cache sync) that acts on behalf of the owner without a browser cookie.
 */
export async function readNeteaseSessionById(
  env: Env,
  id: string,
  now = Date.now()
): Promise<NeteaseSession | null> {
  const { encryptionSecret } = requireIndependentSecrets(env);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return null;
  const record = await env.SESSION_KV.get(sessionKey(id), { type: "json" });
  if (!record || record.version !== 1) return null;
  const stored = record as StoredNeteaseSession;
  if (stored.expiresAt <= now) {
    await env.SESSION_KV.delete(sessionKey(id));
    return null;
  }

  // Sessions of any other account (created before the owner lock) die here.
  if (!(await isOwnerUserId(env, stored.profile?.userId))) {
    await env.SESSION_KV.delete(sessionKey(id));
    return null;
  }

  try {
    const credential = await decryptCredential(
      stored.credential,
      encryptionSecret
    );
    return {
      id,
      credential,
      profile: stored.profile,
      expiresAt: stored.expiresAt,
    };
  } catch {
    await env.SESSION_KV.delete(sessionKey(id));
    return null;
  }
}

/**
 * Sliding expiry: once a day at most, push an active session's expiry back to
 * a full TTL so a PWA that is opened regularly stays signed in indefinitely.
 * Returns the new cookie max-age, or null when no renewal was needed.
 */
export async function renewNeteaseSession(
  env: Env,
  cookieHeader: string | undefined,
  now = Date.now()
): Promise<number | null> {
  const { hmacSecret } = requireIndependentSecrets(env);
  const token = parseCookie(cookieHeader, NETEASE_SESSION_COOKIE);
  if (!token) return null;
  const id = await verifySessionToken(token, hmacSecret);
  if (!id) return null;
  const record = await env.SESSION_KV.get(sessionKey(id), { type: "json" });
  if (!record || record.version !== 1) return null;
  const stored = record as StoredNeteaseSession;
  if (stored.expiresAt <= now) return null;

  const maxAge = getSessionTtl(env);
  const renewedExpiresAt = now + maxAge * 1000;
  if (
    renewedExpiresAt - stored.expiresAt <
    SESSION_RENEW_AFTER_SECONDS * 1000
  ) {
    return null;
  }
  await env.SESSION_KV.put(
    sessionKey(id),
    JSON.stringify({ ...stored, expiresAt: renewedExpiresAt }),
    { expirationTtl: maxAge }
  );
  return maxAge;
}

export async function deleteNeteaseSession(
  env: Env,
  cookieHeader: string | undefined
): Promise<void> {
  const { hmacSecret } = requireIndependentSecrets(env);
  const token = parseCookie(cookieHeader, NETEASE_SESSION_COOKIE);
  if (!token) return;
  const id = await verifySessionToken(token, hmacSecret);
  if (id) await env.SESSION_KV.delete(sessionKey(id));
}
