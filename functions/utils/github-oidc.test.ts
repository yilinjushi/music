// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetGithubOidcCacheForTests,
  verifyGithubOidcToken,
} from "./github-oidc";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const expected = {
  audience: "music-audio-cache",
  repository: "yilinjushi/music",
  ref: "refs/heads/main",
};

async function setup() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "k1",
  };
  const fetcher = (async () => Response.json({ keys: [jwk] })) as typeof fetch;
  const sign = async (claims: Record<string, unknown>) => {
    const head = b64url(
      new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "k1" }))
    );
    const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${head}.${body}`)
    );
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  };
  return { fetcher, sign };
}

const valid = {
  iss: "https://token.actions.githubusercontent.com",
  aud: "music-audio-cache",
  repository: "yilinjushi/music",
  ref: "refs/heads/main",
  exp: Math.floor(Date.now() / 1000) + 300,
};

describe("GitHub OIDC verification", () => {
  beforeEach(() => resetGithubOidcCacheForTests());

  it("accepts a token from this repository's main branch", async () => {
    const { fetcher, sign } = await setup();
    await expect(
      verifyGithubOidcToken(await sign(valid), expected, { fetcher })
    ).resolves.toBe(true);
  });

  it("rejects other repositories, expired tokens and forged signatures", async () => {
    const { fetcher, sign } = await setup();
    const other = await sign({ ...valid, repository: "someone/else" });
    const expired = await sign({ ...valid, exp: 1 });
    const good = await sign(valid);
    const forged = `${good.split(".").slice(0, 2).join(".")}.${b64url(new Uint8Array(256))}`;
    for (const token of [other, expired, forged]) {
      await expect(
        verifyGithubOidcToken(token, expected, { fetcher })
      ).resolves.toBe(false);
    }
  });
});
