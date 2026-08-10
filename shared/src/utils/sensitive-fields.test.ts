import { describe, expect, it } from "vitest";
import {
  CANONICAL_SENSITIVE_FIELD_NAMES,
  classifyCanonicalSensitiveAssignments,
  containsCanonicalSensitiveAssignment,
  isCanonicalSensitiveFieldName,
} from "./sensitive-fields";

function encodeTimes(value: string, passes: number): string {
  let encoded = value;
  for (let pass = 0; pass < passes; pass += 1) {
    encoded = encodeURIComponent(encoded);
  }
  return encoded;
}

describe("canonical sensitive field policy", () => {
  it.each([
    "api_token",
    "secret",
    "X-Request-Key",
    "sessionId",
    "session_id",
    "X-API-Key",
    "X-Auth-Token",
    "vkey",
    "upsig",
    "deadline",
    "wsSecret",
    "ws_time",
    "sign",
    "X-Amz-Signature",
    "X-Amz-Algorithm",
    "X-Goog-Credential",
    "X-Goog-Date",
  ])("classifies required credential/capability field %s", (name) => {
    expect(isCanonicalSensitiveFieldName(name)).toBe(true);
  });

  it("keeps the exported matrix compact and duplicate-free", () => {
    expect(new Set(CANONICAL_SENSITIVE_FIELD_NAMES).size).toBe(
      CANONICAL_SENSITIVE_FIELD_NAMES.length
    );
    expect(
      CANONICAL_SENSITIVE_FIELD_NAMES.every((name) => /^[a-z0-9]+$/.test(name))
    ).toBe(true);
  });

  it.each([
    "api_token",
    "secret",
    "X-Request-Key",
    "session_id",
    "X-API-Key",
    "X-Auth-Token",
    "vkey",
    "upsig",
    "deadline",
    "wsSecret",
    "wsTime",
    "sign",
    "X-Amz-Signature",
    "X-Goog-Credential",
  ])("detects %s after four nested URL-encoding rounds", (name) => {
    expect(
      containsCanonicalSensitiveAssignment(
        encodeTimes(`${name}=four-pass-canary`, 4)
      )
    ).toBe(true);
  });

  it("distinguishes media capabilities from account credentials", () => {
    expect(
      classifyCanonicalSensitiveAssignments(
        "https://cdn.example/a?upsig=one&deadline=2"
      )
    ).toEqual({ hasCapability: true, hasCredential: false });
    expect(
      classifyCanonicalSensitiveAssignments(
        "https://cdn.example/a?api_token=one&secret=two"
      )
    ).toEqual({ hasCapability: false, hasCredential: true });
    expect(
      classifyCanonicalSensitiveAssignments(
        "https://cdn.example/a?wsSecret=one&wsTime=2&sign=three"
      )
    ).toEqual({ hasCapability: true, hasCredential: false });
    expect(
      classifyCanonicalSensitiveAssignments(
        "session_id=one&X-API-Key=two&X-Auth-Token=three"
      )
    ).toEqual({ hasCapability: false, hasCredential: true });
  });

  it("matches sign only as a complete assignment field", () => {
    expect(containsCanonicalSensitiveAssignment("sign=capability")).toBe(true);
    expect(containsCanonicalSensitiveAssignment("design=public-metadata")).toBe(
      false
    );
    expect(
      containsCanonicalSensitiveAssignment("albumSignLanguage=ordinary")
    ).toBe(false);
    expect(
      containsCanonicalSensitiveAssignment("a signed public release note")
    ).toBe(false);
  });

  it.each([
    "Bearer account-secret",
    "Basic YWNjb3VudC1zZWNyZXQ=",
    'Digest username="account",nonce="secret"',
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMiLCJleHAiOjk5OTk5OTk5OTl9.dGVzdC1zaWduYXR1cmUtYnl0ZXM",
  ])("detects a bare credential after one to four encodings: %s", (value) => {
    for (let passes = 1; passes <= 4; passes += 1) {
      const encoded = encodeTimes(value, passes);
      expect(containsCanonicalSensitiveAssignment(encoded)).toBe(true);
      expect(classifyCanonicalSensitiveAssignments(encoded)).toMatchObject({
        hasCredential: true,
      });
    }
  });

  it.each([
    "Basic Instinct",
    "Token Beautiful",
    "Signature Collection",
    "MAC DeMarco",
    "abc.def.ghi",
    "www.youtube.com",
  ])(
    "does not classify legitimate music metadata as a credential: %s",
    (value) => {
      expect(containsCanonicalSensitiveAssignment(value)).toBe(false);
      expect(classifyCanonicalSensitiveAssignments(value)).toEqual({
        hasCapability: false,
        hasCredential: false,
      });
    }
  );
});
