import { stringContainsSensitiveAssignment } from "@/lib/utils/sensitive-data";

const HEALTH_TIMEOUT_MS = 10_000;

async function fetchHealthWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "HEAD",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
  }
}

function isLocalDevelopmentOrigin(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]")
  );
}

/**
 * Account sessions are SameSite=Strict, so a custom API can only name the
 * current HTTPS origin (with an HTTP localhost exception for local tests).
 */
export function normalizeCustomApiOrigin(
  value: string,
  currentOrigin = window.location.origin
): string | null {
  const trimmed = value.trim();
  if (!trimmed || stringContainsSensitiveAssignment(trimmed)) return null;

  try {
    const candidate = new URL(trimmed);
    const current = new URL(currentOrigin);
    const protocolIsSafe =
      candidate.protocol === "https:" || isLocalDevelopmentOrigin(candidate);
    const isOriginOnly =
      candidate.pathname === "/" && !candidate.search && !candidate.hash;
    const isCanonicalInput =
      trimmed === candidate.origin || trimmed === `${candidate.origin}/`;

    if (
      !protocolIsSafe ||
      candidate.username ||
      candidate.password ||
      candidate.origin !== current.origin ||
      !isOriginOnly ||
      !isCanonicalInput
    ) {
      return null;
    }
    return candidate.origin;
  } catch {
    return null;
  }
}

export async function verifyCustomApiOrigin(
  value: string,
  currentOrigin = window.location.origin
): Promise<string> {
  const origin = normalizeCustomApiOrigin(value, currentOrigin);
  if (!origin) throw new Error("UNSAFE_API_ORIGIN");

  const response = await fetchHealthWithTimeout(`${origin}/health`);
  if (!response.ok) throw new Error("API_HEALTH_CHECK_FAILED");
  return origin;
}
