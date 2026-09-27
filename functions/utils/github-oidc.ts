/**
 * Verifies a GitHub Actions OIDC token (RS256 JWT) so a scheduled workflow in
 * this repository can call the site without any shared secret to manage.
 */
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;

interface Jwk extends JsonWebKey {
  kid?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function loadJwks(fetcher: typeof fetch): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 60 * 60_000) {
    return jwksCache.keys;
  }
  const response = await fetcher(GITHUB_OIDC_JWKS);
  if (!response.ok) throw new Error("JWKS_UNAVAILABLE");
  const payload = (await response.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

export async function verifyGithubOidcToken(
  token: string,
  expected: { audience: string; repository: string; ref: string },
  options: { now?: number; fetcher?: typeof fetch } = {}
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8192) return false;
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!header || !claims || header.alg !== "RS256") return false;

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (
    claims.iss !== GITHUB_OIDC_ISSUER ||
    claims.aud !== expected.audience ||
    claims.repository !== expected.repository ||
    claims.ref !== expected.ref ||
    typeof claims.exp !== "number" ||
    claims.exp < now ||
    (typeof claims.nbf === "number" && claims.nbf > now + 60)
  ) {
    return false;
  }

  try {
    const keys = await loadJwks(options.fetcher ?? fetch);
    const jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return false;
  }
}

export function resetGithubOidcCacheForTests() {
  jwksCache = null;
}
