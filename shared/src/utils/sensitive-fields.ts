/**
 * Canonical credential/capability field policy shared by the browser and
 * Cloudflare Functions. Values are stored in compact form so casing and the
 * separators commonly used by HTTP headers, JSON and query strings cannot
 * create policy drift between layers.
 */
export const CANONICAL_SENSITIVE_FIELD_NAMES = [
  "accesstoken",
  "apikey",
  "apisecret",
  "apitoken",
  "auth",
  "authkey",
  "authorization",
  "authtoken",
  "awsaccesskeyid",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "csrf",
  "csrftoken",
  "deadline",
  "expires",
  "googleaccessid",
  "hdntl",
  "hdnts",
  "idtoken",
  "keypairid",
  "musicu",
  "passwd",
  "password",
  "policy",
  "proxyauth",
  "proxyauthenticate",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "secretkey",
  "sessionid",
  "sessioncookie",
  "sessiontoken",
  "setcookie",
  "sig",
  "sign",
  "signature",
  "token",
  "upsig",
  "vkey",
  "wssecret",
  "wstime",
  "xapikey",
  "xauthtoken",
  "xcsrftoken",
  "xforwardedcookie",
  "xrequestkey",
  "xrealcookie",
  "xsrf",
  "xsrftoken",
  "xxsrftoken",
] as const;

export const SENSITIVE_DECODE_PASSES = 4;

/** Fields that can be short-lived media capabilities, never account secrets. */
export const CANONICAL_CAPABILITY_FIELD_NAMES = [
  "authkey",
  "awsaccesskeyid",
  "deadline",
  "expires",
  "googleaccessid",
  "hdntl",
  "hdnts",
  "keypairid",
  "policy",
  "sig",
  "sign",
  "signature",
  "token",
  "upsig",
  "vkey",
  "wssecret",
  "wstime",
] as const;

const SENSITIVE_FIELD_NAMES = new Set<string>(CANONICAL_SENSITIVE_FIELD_NAMES);
const CAPABILITY_FIELD_NAMES = new Set<string>(
  CANONICAL_CAPABILITY_FIELD_NAMES
);
const SENSITIVE_ASSIGNMENT_PATTERN =
  /(?:^|[?&#;,/=\s{[(])["']?([a-z_][a-z0-9_.-]{0,64})["']?\s*(?:=|:)/gi;
const SPACED_PROXY_AUTH_PATTERN =
  /(?:^|[?&#;,/=\s{[(])["']?proxy\s+(?:authorization|auth)["']?\s*(?:=|:)/i;
const BARE_AUTH_CREDENTIAL_PATTERN =
  /(?:^|[\s:=,;|([{])(Bearer|Basic|Negotiate|NTLM|Api[-_ ]?Key|Token|OAuth|MAC|HMAC|Signature|SCRAM-SHA-256|AWS4-HMAC-SHA256)\s+([A-Za-z0-9._~+/=-]{8,})/gi;
const DIGEST_CREDENTIAL_PATTERN =
  /(?:^|[\s:=,;|([{])Digest\s+[^\r\n]{0,2048}\b(?:username|realm|nonce|uri|response|cnonce)\s*=/i;
const COMPLETE_JWT_PATTERN =
  /^([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{16,})$/;

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  if (segment.length > 4096 || segment.length % 4 === 1) return null;
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isStructuredJwt(value: string): boolean {
  const match = value.trim().match(COMPLETE_JWT_PATTERN);
  if (!match) return false;
  const header = decodeBase64UrlJson(match[1]);
  const payload = decodeBase64UrlJson(match[2]);
  return typeof header?.alg === "string" && payload !== null;
}

function isBase64Credential(value: string): boolean {
  return (
    value.length >= 12 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function containsBareAuthCredential(value: string): boolean {
  if (DIGEST_CREDENTIAL_PATTERN.test(value)) return true;
  BARE_AUTH_CREDENTIAL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_AUTH_CREDENTIAL_PATTERN.exec(value)) !== null) {
    const scheme = match[1].toLowerCase().replace(/[-_ ]/g, "");
    const credential = match[2];
    if (scheme === "basic" || scheme === "negotiate" || scheme === "ntlm") {
      if (isBase64Credential(credential)) return true;
      continue;
    }
    if (scheme === "bearer" && isStructuredJwt(credential)) return true;
    const minimumLength = scheme === "bearer" ? 12 : 16;
    if (credential.length >= minimumLength && /[0-9._~+/=-]/.test(credential)) {
      return true;
    }
  }
  return false;
}

export function compactSensitiveFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Return the original string plus at most four URL-decoded variants. */
export function sensitiveDecodeVariants(value: string): string[] {
  const variants = [value];
  let current = value;

  for (let pass = 0; pass < SENSITIVE_DECODE_PASSES; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current.replace(/\+/g, "%20"));
    } catch {
      // A malformed, unrelated '%' must not hide otherwise valid escapes.
      decoded = current
        .replace(/\+/g, " ")
        .replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16))
        );
    }
    if (decoded === current) break;
    variants.push(decoded);
    current = decoded;
  }

  return variants;
}

export function isCanonicalSensitiveFieldName(value: string): boolean {
  return sensitiveDecodeVariants(value).some((variant) => {
    const compact = compactSensitiveFieldName(variant);
    return (
      SENSITIVE_FIELD_NAMES.has(compact) ||
      compact.startsWith("xamz") ||
      compact.startsWith("xgoog")
    );
  });
}

export function isCanonicalCapabilityFieldName(value: string): boolean {
  return sensitiveDecodeVariants(value).some((variant) => {
    const compact = compactSensitiveFieldName(variant);
    return (
      CAPABILITY_FIELD_NAMES.has(compact) ||
      compact.startsWith("xamz") ||
      compact.startsWith("xgoog")
    );
  });
}

export interface CanonicalSensitiveClassification {
  hasCapability: boolean;
  hasCredential: boolean;
}

function variantContainsSensitiveAssignment(value: string): boolean {
  if (
    SPACED_PROXY_AUTH_PATTERN.test(value) ||
    containsBareAuthCredential(value) ||
    isStructuredJwt(value)
  ) {
    return true;
  }
  SENSITIVE_ASSIGNMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENSITIVE_ASSIGNMENT_PATTERN.exec(value)) !== null) {
    if (isCanonicalSensitiveFieldName(match[1])) return true;
  }
  return false;
}

function classifyVariant(value: string): CanonicalSensitiveClassification {
  let hasCapability = false;
  let hasCredential =
    SPACED_PROXY_AUTH_PATTERN.test(value) ||
    containsBareAuthCredential(value) ||
    isStructuredJwt(value);
  SENSITIVE_ASSIGNMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENSITIVE_ASSIGNMENT_PATTERN.exec(value)) !== null) {
    if (!isCanonicalSensitiveFieldName(match[1])) continue;
    if (isCanonicalCapabilityFieldName(match[1])) hasCapability = true;
    else hasCredential = true;
  }
  return { hasCapability, hasCredential };
}

export function classifyCanonicalSensitiveAssignments(
  value: string
): CanonicalSensitiveClassification {
  let hasCapability = false;
  let hasCredential = false;
  for (const variant of sensitiveDecodeVariants(value)) {
    const classification = classifyVariant(variant);
    hasCapability ||= classification.hasCapability;
    hasCredential ||= classification.hasCredential;
  }
  return { hasCapability, hasCredential };
}

/** Detect sensitive assignments or bare credentials through the decode policy. */
export function containsCanonicalSensitiveAssignment(value: string): boolean {
  return sensitiveDecodeVariants(value).some(
    variantContainsSensitiveAssignment
  );
}
