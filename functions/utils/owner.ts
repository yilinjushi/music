import type { Env } from "../types/hono";

/**
 * This app is single-user. The owner is identified by the SHA-256 of
 * "netease-owner:<NetEase userId>" (configured as OWNER_NETEASE_UID_SHA256),
 * so no account id is stored in the repository. Missing config denies everyone.
 */
const encoder = new TextEncoder();

async function ownerHash(userId: string | number): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`netease-owner:${userId}`)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function isOwnerUserId(
  env: Pick<Env, "OWNER_NETEASE_UID_SHA256">,
  userId: unknown
): Promise<boolean> {
  const expected = env.OWNER_NETEASE_UID_SHA256?.trim().toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return false;
  if (typeof userId !== "string" && typeof userId !== "number") return false;
  return (await ownerHash(userId)) === expected;
}

export const OWNER_ONLY_MESSAGE = "此应用仅限本人使用";
