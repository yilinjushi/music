import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyPlaybackEvidence } from "./verify-playback-sample.mjs";

function validEvidence() {
  const frozenAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const testedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const fixture = {
    frozenAt,
    legalScope:
      "Account-accessible tracks tested without bypassing access controls.",
    samples: Array.from({ length: 100 }, (_, index) => ({
      id: `netease-${index + 1}`,
      title: `Evidence Track ${index + 1}`,
      artists: [`Artist ${index + 1}`],
      album: `Album ${index + 1}`,
      durationMs: 180000 + index,
      legalBasis: "account-accessible",
    })),
  };
  const fixtureBytes = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`);
  const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
  const result = {
    fixtureSha256,
    environment: {
      httpsUrl: "https://preview.example.com",
      testedAt,
      androidChrome: "Chrome/140.0.7339.123; Android 15; Google Pixel 8",
      accountHash: "0123456789abcdef0123456789abcdef",
    },
    samples: fixture.samples.map((sample) => ({
      id: sample.id,
      status: "playable",
      resolvedSource: "netease",
      actualTitle: sample.title,
      actualArtists: sample.artists,
      actualAlbum: sample.album,
      actualDurationMs: sample.durationMs,
      identityMatch: true,
      observedPlaybackSeconds: 15,
      sourceAttempts: [
        { source: "netease", outcome: "playable", observedAt: testedAt },
      ],
    })),
  };
  return { fixture, fixtureBytes, result };
}

test("accepts a complete, internally consistent 100-track attestation", () => {
  const { fixture, fixtureBytes, result } = validEvidence();
  const report = verifyPlaybackEvidence(fixtureBytes, fixture, result);
  assert.equal(report.ok, true, report.failures.join("\n"));
  assert.equal(report.playableRate, 1);
  assert.equal(report.mismatches, 0);
  assert.match(report.evidenceLimitation, /cannot prove/i);
});

test("does not trust a caller-supplied identityMatch flag", () => {
  const { fixture, fixtureBytes, result } = validEvidence();
  result.samples[0].actualTitle = "A different recording";
  result.samples[0].identityMatch = true;
  const report = verifyPlaybackEvidence(fixtureBytes, fixture, result);
  assert.equal(report.ok, false);
  assert.equal(report.mismatches, 1);
  assert.ok(
    report.failures.some((failure) => failure.includes("claimed identityMatch"))
  );
});

test("accepts exactly 99 playable tracks and one honest unplayable result", () => {
  const { fixture, fixtureBytes, result } = validEvidence();
  result.samples[99] = {
    id: fixture.samples[99].id,
    status: "unplayable",
    observedPlaybackSeconds: 0,
    sourceAttempts: [
      {
        source: "netease",
        outcome: "unavailable",
        observedAt: result.environment.testedAt,
      },
    ],
  };

  const report = verifyPlaybackEvidence(fixtureBytes, fixture, result);
  assert.equal(report.ok, true, report.failures.join("\n"));
  assert.equal(report.playable, 99);
  assert.equal(report.playableRate, 0.99);
  assert.equal(report.mismatches, 0);
});

test("rejects contradictory non-playable evidence", () => {
  const { fixture, fixtureBytes, result } = validEvidence();
  result.samples[99] = {
    id: fixture.samples[99].id,
    status: "unplayable",
    resolvedSource: "netease",
    observedPlaybackSeconds: 5,
    sourceAttempts: [
      {
        source: "netease",
        outcome: "playable",
        observedAt: result.environment.testedAt,
      },
    ],
  };

  const report = verifyPlaybackEvidence(fixtureBytes, fixture, result);
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some((failure) =>
      failure.includes("must not claim a resolvedSource")
    )
  );
  assert.ok(
    report.failures.some((failure) =>
      failure.includes("must not contain a playable sourceAttempt")
    )
  );
});

test("rejects non-HTTPS environments and unequal result sets", () => {
  const { fixture, fixtureBytes, result } = validEvidence();
  result.environment.httpsUrl = "not-https";
  result.samples.pop();
  result.samples.push({ ...result.samples[0] });
  const report = verifyPlaybackEvidence(fixtureBytes, fixture, result);
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some((failure) => failure.includes("public HTTPS URL"))
  );
  assert.ok(
    report.failures.some((failure) => failure.includes("duplicate result id"))
  );
  assert.ok(
    report.failures.some((failure) => failure.includes("missing result"))
  );
});
