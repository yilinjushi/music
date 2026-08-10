import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger, sanitizeLogText, sanitizeLogValue } from "./logger";

describe("logger redaction", () => {
  beforeEach(() => {
    localStorage.clear();
    logger.clear();
  });

  it("keeps only origin and pathname for absolute and relative URLs", () => {
    expect(
      sanitizeLogText(
        "GET https://music.example/proxy?url=https%3A%2F%2Fcdn.example%2Fa#x failed"
      )
    ).toBe("GET https://music.example/proxy failed");
    expect(sanitizeLogText("request /music-api/search?token=secret")).toBe(
      "request /music-api/search"
    );
  });

  it("recursively redacts secret-bearing metadata fields", () => {
    expect(
      sanitizeLogValue({
        headers: { Authorization: "Bearer private", Cookie: "session=x" },
        nested: [{ music_u: "private", token: "private" }],
        url: "https://example.test/path?q=private#hash",
        urlObject: new URL("https://example.test/token=path-canary?q=private"),
      })
    ).toEqual({
      headers: { Authorization: "[REDACTED]", Cookie: "[REDACTED]" },
      nested: [{ music_u: "[REDACTED]", token: "[REDACTED]" }],
      url: "https://example.test/path",
      urlObject: "https://example.test/token=[REDACTED]",
    });
  });

  it("redacts plain, Bearer, encoded, and repeatedly encoded assignments", () => {
    const canary = "unique-logger-canary-71f4";
    const sanitized = sanitizeLogText(
      [
        `MUSIC_U=${canary}`,
        `Authorization: Bearer ${canary}`,
        `ordinary Bearer ${canary}`,
        `music_u%3D${canary}`,
        `authorization%253A%2520Bearer%2520${canary}`,
        `api_token%2525253D${canary}`,
        `secret%2525253D${canary}`,
        `X-Request-Key%2525253D${canary}`,
        `vkey%2525253D${canary}`,
        `upsig%2525253D${canary}`,
        `deadline%2525253D${canary}`,
        `X-Amz-Signature=${canary}`,
        `X-Goog-Credential=${canary}`,
        `Expires=${canary}`,
        `Policy=${canary}`,
      ].join(" | ")
    );

    expect(sanitized).not.toContain(canary);
    expect(sanitized).toContain("[REDACTED]");
  });

  it.each([
    "Authorization: Bearer bearer-canary.with-punctuation+/= and trailing credential data",
    "Authorization: Basic basic-canary==",
    'Proxy-Authorization: Digest username="digest-user-canary", realm="digest-realm-canary", nonce="digest-nonce-canary", response="digest-response-canary"',
    "Authorization: Negotiate negotiate-canary==",
    "Authorization: OAuth oauth-canary with-spaces",
    "Authorization: Token token-canary with-spaces",
    "X-API-Key: api-key-header-canary",
    "API-key api-key-scheme-canary with-spaces",
    "Authorization: AWS4-HMAC-SHA256 Credential=aws-canary/20260809/region/service/aws4_request, SignedHeaders=host, Signature=aws-signature-canary",
  ])("redacts a complete authorization credential: %s", (credential) => {
    const sanitized = sanitizeLogText(`request failed | ${credential}`);
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).not.toMatch(/canary/i);
  });

  it("finds a sensitive assignment nested inside ordinary labeled text", () => {
    const sanitized = sanitizeLogText(
      "response: safe-prefix token=nested-canary safe-suffix"
    );
    expect(sanitized).toBe(
      "response: safe-prefix token=[REDACTED] safe-suffix"
    );
    expect(sanitized).not.toContain("nested-canary");
  });

  it("uses the unified key policy for structured secret fields", () => {
    const canary = "structured-secret-canary-a813";
    const sanitized = sanitizeLogValue({
      api_token: canary,
      secret: canary,
      "X-Request-Key": canary,
      sessionId: canary,
      session_id: canary,
      "X-API-Key": canary,
      "X-Auth-Token": canary,
      vkey: canary,
      upsig: canary,
      deadline: canary,
      wsSecret: canary,
      wsTime: canary,
      sign: canary,
      password: canary,
      client_secret: canary,
      signature: canary,
      "X-Amz-Credential": canary,
      "X-Goog-Signature": canary,
      Expires: canary,
      Policy: canary,
      safe: "ordinary metadata",
    });

    expect(JSON.stringify(sanitized)).not.toContain(canary);
    expect(sanitized).toMatchObject({
      api_token: "[REDACTED]",
      secret: "[REDACTED]",
      "X-Request-Key": "[REDACTED]",
      sessionId: "[REDACTED]",
      session_id: "[REDACTED]",
      "X-API-Key": "[REDACTED]",
      "X-Auth-Token": "[REDACTED]",
      vkey: "[REDACTED]",
      upsig: "[REDACTED]",
      deadline: "[REDACTED]",
      wsSecret: "[REDACTED]",
      wsTime: "[REDACTED]",
      sign: "[REDACTED]",
      password: "[REDACTED]",
      client_secret: "[REDACTED]",
      signature: "[REDACTED]",
      "X-Amz-Credential": "[REDACTED]",
      "X-Goog-Signature": "[REDACTED]",
      Expires: "[REDACTED]",
      Policy: "[REDACTED]",
      safe: "ordinary metadata",
    });
  });

  it("never persists proxy query parameters or credentials", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    logger.error(
      "Network",
      "Fetch failed: https://app.test/proxy?url=https%3A%2F%2Fcdn.test%2Fa&token=secret",
      new Error("GET /proxy?url=private failed"),
      { authorization: "Bearer secret", safe: "ok" }
    );

    const persisted = localStorage.getItem("otter-debug-logs") ?? "";
    expect(persisted).toContain("https://app.test/proxy");
    expect(persisted).not.toContain("cdn.test");
    expect(persisted).not.toContain("Bearer secret");
    expect(persisted).not.toContain("url=private");
    expect(persisted).toContain("[REDACTED]");

    const consoleOutput = JSON.stringify(consoleError.mock.calls);
    expect(consoleOutput).not.toContain("cdn.test");
    expect(consoleOutput).not.toContain("Bearer secret");
    expect(consoleOutput).not.toContain("url=private");
    expect(consoleOutput).toContain("[REDACTED]");
    consoleError.mockRestore();
  });

  it("keeps a unique canary out of console, storage, and export", () => {
    const canary = "unique-logger-canary-e2b9";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    logger.error(
      "Security",
      `MUSIC_U=${canary}; Bearer ${canary}`,
      new Error(`authorization%253A%2520Bearer%2520${canary}`),
      { note: `cookie=${canary}` }
    );

    const consoleOutput = JSON.stringify(consoleError.mock.calls);
    const persisted = localStorage.getItem("otter-debug-logs") ?? "";
    const exported = logger.exportText();
    expect(consoleOutput).not.toContain(canary);
    expect(persisted).not.toContain(canary);
    expect(exported).not.toContain(canary);
    expect(`${consoleOutput}${persisted}${exported}`).toContain("[REDACTED]");
    consoleError.mockRestore();
  });

  it("keeps non-Bearer credentials out of exceptions, console, storage, and export", () => {
    const canaries = [
      "basic-channel-canary",
      "digest-user-canary",
      "digest-response-canary",
      "api-key-channel-canary",
    ];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    logger.error(
      "Security",
      `Authorization: Basic ${canaries[0]}==`,
      new Error(
        `Proxy-Authorization: Digest username="${canaries[1]}", nonce="n", response="${canaries[2]}"`
      ),
      {
        "X-API-Key": canaries[3],
        nested: `ApiKey ${canaries[3]} with trailing credential data`,
      }
    );
    logger.error(
      "HeaderSecurityException",
      "Custom authorization exception",
      new Error(
        `Proxy-Authorization: Another.Custom ${canaries[1]} value with spaces!`
      )
    );

    const combined = [
      JSON.stringify(consoleError.mock.calls),
      localStorage.getItem("otter-debug-logs") ?? "",
      logger.exportText(),
    ].join("\n");
    for (const canary of canaries) expect(combined).not.toContain(canary);
    expect(combined).toContain("[REDACTED]");
    consoleError.mockRestore();
  });

  it("redacts complete sensitive header values with custom auth schemes on every channel", () => {
    const canaries = [
      "authorization-custom-canary",
      "proxy-custom-canary",
      "api-key-header-canary",
      "auth-token-header-canary",
      "cookie-header-canary",
      "set-cookie-header-canary",
    ];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    logger.error(
      "HeaderSecurity",
      [
        `Authorization: Fancy.Custom-Scheme ${canaries[0]} value with spaces, commas; punctuation!`,
        `X-API-Key: Vendor-Key ${canaries[2]} /+= with spaces`,
      ].join("\n"),
      new Error(
        `Proxy-Authorization: Bespoke ${canaries[1]} value, nonce=(punctuation)`
      ),
      {
        noteOne: `X-Auth-Token: Custom ${canaries[3]} value with spaces`,
        noteTwo: `Cookie: sid=${canaries[4]}; Path=/; HttpOnly`,
        noteThree: `Set-Cookie: sid=${canaries[5]}; Path=/; Secure`,
      }
    );

    const combined = [
      JSON.stringify(consoleError.mock.calls),
      localStorage.getItem("otter-debug-logs") ?? "",
      logger.exportText(),
    ].join("\n");
    for (const canary of canaries) expect(combined).not.toContain(canary);
    expect(combined).toContain("[REDACTED]");
    consoleError.mockRestore();
  });

  it.each([
    "Authorization=Custom alpha-canary beta trailing",
    "Proxy-Authorization=Bespoke proxy-canary with spaces",
    "X-API-Key=Vendor api-key-canary with spaces",
    "Cookie=session=abc; cookie-tail-canary with spaces",
  ])(
    "redacts equals-delimited sensitive header values to line end: %s",
    (line) => {
      const sanitized = sanitizeLogText(`failure | ${line}\nnext=safe`);
      expect(sanitized).toContain("[REDACTED]\nnext=safe");
      expect(sanitized).not.toMatch(
        /alpha-canary|proxy-canary|api-key-canary|cookie-tail-canary/
      );
    }
  );

  it("sanitizes and immediately overwrites legacy persisted logs", async () => {
    const canary = "unique-legacy-canary-9c31";
    localStorage.setItem(
      "otter-debug-logs",
      JSON.stringify([
        {
          id: "legacy-1",
          time: "2026-01-01 00:00:00",
          level: "error",
          source: "legacy",
          message: `MUSIC_U=${canary}`,
          stack: `authorization%253A%2520Bearer%2520${canary}`,
          context: { note: `ordinary Bearer ${canary}` },
        },
      ])
    );

    vi.resetModules();
    const freshModule = await import("./logger");
    const persisted = localStorage.getItem("otter-debug-logs") ?? "";
    const exported = freshModule.logger.exportText();

    expect(persisted).not.toContain(canary);
    expect(exported).not.toContain(canary);
    expect(persisted).toContain("[REDACTED]");
  });
});
