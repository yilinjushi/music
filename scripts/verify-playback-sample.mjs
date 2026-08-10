import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot, writeJson } from "./evidence-utils.mjs";
import { acquireEvidencePipelineLock } from "./exclusive-run-lock.mjs";

const RESULT_STATUSES = new Set(["playable", "unplayable", "error"]);
const ATTEMPT_OUTCOMES = new Set([
  "playable",
  "unavailable",
  "failed",
  "blocked",
  "mismatch",
]);
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function nonEmptyString(value, maxLength = 500) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

export function isStrictIsoUtc(value) {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
  );
  if (!match) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const [, year, month, day, hour, minute, second] = match;
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second)
  );
}

export function normalizeIdentityText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedArtists(values) {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .flatMap((value) =>
          String(value).split(/\s*(?:\/|、|,|&|;|\bfeat\.?\b)\s*/i)
        )
        .map(normalizeIdentityText)
        .filter(Boolean)
    ),
  ].sort();
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validHttpsEvidenceUrl(value) {
  if (!nonEmptyString(value, 2048)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      host.includes(".") &&
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "::1" &&
      !host.endsWith(".invalid")
    );
  } catch {
    return false;
  }
}

function validAndroidChrome(value) {
  if (!nonEmptyString(value, 300)) return false;
  const fields = value.split(";").map((field) => field.trim());
  return (
    fields.length >= 3 &&
    /^Chrome\/\d{2,3}(?:\.\d+){3}$/i.test(fields[0]) &&
    /^Android\s+\d+(?:\.\d+)?$/i.test(fields[1]) &&
    fields[2].length >= 3 &&
    !/^(?:device|model|unknown)$/i.test(fields[2])
  );
}

function validateMetadata(sample, label, failures) {
  if (!nonEmptyString(sample?.id, 200))
    failures.push(`${label} has an invalid id`);
  if (!nonEmptyString(sample?.title, 500)) {
    failures.push(`${label} has an empty title`);
  }
  if (
    !Array.isArray(sample?.artists) ||
    sample.artists.length === 0 ||
    sample.artists.some((artist) => !nonEmptyString(artist, 300))
  ) {
    failures.push(`${label} must have one or more non-empty artists`);
  }
  if (
    !Number.isFinite(sample?.durationMs) ||
    sample.durationMs <= 0 ||
    sample.durationMs > 6 * 60 * 60 * 1000
  ) {
    failures.push(`${label} has an invalid durationMs`);
  }
}

export function verifyPlaybackEvidence(
  fixtureBytes,
  fixture,
  result,
  now = Date.now()
) {
  const failures = [];
  const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");

  if (!isStrictIsoUtc(fixture?.frozenAt)) {
    failures.push("fixture frozenAt must be a valid UTC ISO-8601 timestamp");
  }
  if (
    !nonEmptyString(fixture?.legalScope, 1000) ||
    fixture.legalScope.trim().length < 20
  ) {
    failures.push(
      "fixture legalScope must be a substantive non-empty statement"
    );
  }
  if (!Array.isArray(fixture?.samples) || fixture.samples.length < 100) {
    failures.push("the frozen fixture must contain at least 100 tracks");
  }
  if (result?.fixtureSha256 !== fixtureSha256) {
    failures.push(
      "the result does not reference the exact frozen fixture bytes"
    );
  }

  const environment = result?.environment;
  if (!validHttpsEvidenceUrl(environment?.httpsUrl)) {
    failures.push(
      "environment httpsUrl must be a credential-free public HTTPS URL"
    );
  }
  if (!isStrictIsoUtc(environment?.testedAt)) {
    failures.push(
      "environment testedAt must be a valid UTC ISO-8601 timestamp"
    );
  }
  if (!validAndroidChrome(environment?.androidChrome)) {
    failures.push(
      "environment androidChrome must use 'Chrome/x.x.x.x; Android N; device model'"
    );
  }
  if (!/^[a-f0-9]{16,128}$/i.test(String(environment?.accountHash ?? ""))) {
    failures.push(
      "environment accountHash must be a 16-128 character hexadecimal digest"
    );
  }
  if (
    isStrictIsoUtc(fixture?.frozenAt) &&
    isStrictIsoUtc(environment?.testedAt)
  ) {
    const frozenAt = Date.parse(fixture.frozenAt);
    const testedAt = Date.parse(environment.testedAt);
    if (testedAt < frozenAt)
      failures.push("testedAt must not precede frozenAt");
    if (
      frozenAt > now + FUTURE_TOLERANCE_MS ||
      testedAt > now + FUTURE_TOLERANCE_MS
    ) {
      failures.push("fixture or result timestamp is implausibly in the future");
    }
  }

  const fixtureIds = new Set();
  for (const [index, sample] of (fixture?.samples ?? []).entries()) {
    const label = `fixture sample ${index + 1}`;
    validateMetadata(sample, label, failures);
    if (!nonEmptyString(sample?.legalBasis, 300)) {
      failures.push(`${label} has no legalBasis`);
    }
    if (fixtureIds.has(sample?.id))
      failures.push(`duplicate fixture id: ${sample.id}`);
    if (nonEmptyString(sample?.id, 200)) fixtureIds.add(sample.id);
  }

  if (!Array.isArray(result?.samples)) {
    failures.push("result samples must be an array");
  }
  const resultsById = new Map();
  for (const [index, sample] of (result?.samples ?? []).entries()) {
    const label = `result sample ${index + 1}`;
    if (!nonEmptyString(sample?.id, 200)) {
      failures.push(`${label} has an invalid id`);
      continue;
    }
    if (resultsById.has(sample.id))
      failures.push(`duplicate result id: ${sample.id}`);
    resultsById.set(sample.id, sample);
  }
  if ((result?.samples ?? []).length !== (fixture?.samples ?? []).length) {
    failures.push(
      "fixture and result sample arrays must have identical cardinality"
    );
  }
  for (const id of resultsById.keys()) {
    if (!fixtureIds.has(id)) failures.push(`unexpected result id: ${id}`);
  }

  let playable = 0;
  let mismatches = 0;
  const comparisons = [];
  for (const expected of fixture?.samples ?? []) {
    const observed = resultsById.get(expected.id);
    if (!observed) {
      failures.push(`missing result for fixture: ${expected.id}`);
      continue;
    }
    if (!RESULT_STATUSES.has(observed.status)) {
      failures.push(`result ${expected.id} has an invalid status`);
    }

    if (observed.status === "playable") {
      validateMetadata(
        {
          id: observed.id,
          title: observed.actualTitle,
          artists: observed.actualArtists,
          durationMs: observed.actualDurationMs,
        },
        `result ${expected.id} actual metadata`,
        failures
      );
    }
    if (
      !Array.isArray(observed.sourceAttempts) ||
      observed.sourceAttempts.length === 0
    ) {
      failures.push(
        `result ${expected.id} must record one or more sourceAttempts`
      );
    }
    for (const [attemptIndex, attempt] of (
      observed.sourceAttempts ?? []
    ).entries()) {
      if (!nonEmptyString(attempt?.source, 100)) {
        failures.push(
          `result ${expected.id} attempt ${attemptIndex + 1} has no source`
        );
      }
      if (!ATTEMPT_OUTCOMES.has(attempt?.outcome)) {
        failures.push(
          `result ${expected.id} attempt ${attemptIndex + 1} has an invalid outcome`
        );
      }
      if (!isStrictIsoUtc(attempt?.observedAt)) {
        failures.push(
          `result ${expected.id} attempt ${attemptIndex + 1} has an invalid observedAt`
        );
      }
    }
    if (
      !Number.isFinite(observed.observedPlaybackSeconds) ||
      observed.observedPlaybackSeconds < 0
    ) {
      failures.push(
        `result ${expected.id} has an invalid observedPlaybackSeconds`
      );
    }

    const successfulAttempts = (observed.sourceAttempts ?? []).filter(
      (attempt) => attempt?.outcome === "playable"
    );
    if (observed.status !== "playable") {
      if (nonEmptyString(observed.resolvedSource, 100)) {
        failures.push(
          `non-playable result ${expected.id} must not claim a resolvedSource`
        );
      }
      if (successfulAttempts.length > 0) {
        failures.push(
          `non-playable result ${expected.id} must not contain a playable sourceAttempt`
        );
      }
      if (observed.observedPlaybackSeconds !== 0) {
        failures.push(
          `non-playable result ${expected.id} must record zero observedPlaybackSeconds`
        );
      }
    }

    const titleMatch =
      normalizeIdentityText(expected.title) ===
      normalizeIdentityText(observed.actualTitle);
    const artistsMatch = sameStrings(
      normalizedArtists(expected.artists),
      normalizedArtists(observed.actualArtists)
    );
    const durationToleranceMs = Math.max(5000, expected.durationMs * 0.03);
    const durationMatch =
      Number.isFinite(observed.actualDurationMs) &&
      Math.abs(expected.durationMs - observed.actualDurationMs) <=
        durationToleranceMs;
    const albumMatch = expected.album
      ? nonEmptyString(observed.actualAlbum, 500) &&
        normalizeIdentityText(expected.album) ===
          normalizeIdentityText(observed.actualAlbum)
      : true;
    const identityMatch =
      titleMatch && artistsMatch && durationMatch && albumMatch;
    if (
      typeof observed.identityMatch === "boolean" &&
      observed.identityMatch !== identityMatch
    ) {
      failures.push(
        `result ${expected.id} claimed identityMatch=${observed.identityMatch} but computed ${identityMatch}`
      );
    }

    if (observed.status === "playable") {
      playable += 1;
      if (!identityMatch) mismatches += 1;
      if (!nonEmptyString(observed.resolvedSource, 100)) {
        failures.push(`playable result ${expected.id} has no resolvedSource`);
      }
      const matchingAttempt = successfulAttempts.some(
        (attempt) =>
          normalizeIdentityText(attempt.source) ===
          normalizeIdentityText(observed.resolvedSource)
      );
      if (!matchingAttempt) {
        failures.push(
          `playable result ${expected.id} has no successful attempt for resolvedSource`
        );
      }
      const requiredObservation = Math.min(
        15,
        Math.max(1, observed.actualDurationMs / 1000 - 1)
      );
      if (observed.observedPlaybackSeconds < requiredObservation) {
        failures.push(
          `playable result ${expected.id} was observed for less than ${requiredObservation.toFixed(1)} seconds`
        );
      }
    }

    comparisons.push({
      id: expected.id,
      status: observed.status,
      titleMatch,
      artistsMatch,
      durationMatch,
      albumMatch,
      identityMatch,
    });
  }

  const total = fixtureIds.size;
  const playableRate = total === 0 ? 0 : playable / total;
  if (playableRate < 0.99) {
    failures.push(
      `playable rate ${(playableRate * 100).toFixed(2)}% is below 99%`
    );
  }
  if (mismatches !== 0) {
    failures.push(
      `${mismatches} playable tracks were computed identity mismatches`
    );
  }

  return {
    ok: failures.length === 0,
    evidenceType: "structured human-observation attestation",
    evidenceLimitation:
      "This verifier validates schema, set integrity, self-consistency, identity metadata, and thresholds. It cannot prove that a human actually performed the recorded playback observations; retain independent device/video/network evidence.",
    fixtureSha256,
    total,
    playable,
    playableRate,
    mismatches,
    comparisons,
    failures,
  };
}

export function main() {
  const [fixtureArg, resultArg] = process.argv.slice(2);
  if (!fixtureArg || !resultArg) {
    console.error(
      "Usage: node scripts/verify-playback-sample.mjs <frozen-sample.json> <result.json>"
    );
    process.exitCode = 2;
    return;
  }

  const releasePipelineLock = acquireEvidencePipelineLock(
    projectRoot,
    "Real-device playback evidence"
  );
  process.on("exit", releasePipelineLock);

  try {
    const fixtureBytes = readFileSync(resolve(fixtureArg));
    const fixture = JSON.parse(fixtureBytes.toString("utf8"));
    const result = JSON.parse(readFileSync(resolve(resultArg), "utf8"));
    const summary = verifyPlaybackEvidence(fixtureBytes, fixture, result);
    writeJson(
      join(projectRoot, "artifacts", "playback-verification.json"),
      summary
    );
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
