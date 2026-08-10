import assert from "node:assert/strict";
import test from "node:test";
import {
  AGGREGATE_COMPRESSION_MAX_RATIO,
  ENTRY_COMPRESSION_MAX_RATIO,
  LARGE_APPLICATION_ASSET_MINIMUM_BYTES_EXCLUSIVE,
  analyzeSyntheticStaticDelivery,
} from "./lighthouse-static-delivery.mjs";

const baseUrl = "http://127.0.0.1:4173";
const requiredEntryAssets = [
  "/assets/index-12345678.js",
  "/assets/index-abcdefgh.css",
];

function asset(file, overrides = {}) {
  return {
    url: `${baseUrl}/assets/${file}`,
    statusCode: 200,
    cache: "none",
    resourceSize: 4_000,
    transferSize: 1_000,
    ...overrides,
  };
}

function validRequests(extra = []) {
  return [
    asset("index-12345678.js"),
    asset("index-abcdefgh.css", { transferSize: 800 }),
    ...extra,
  ];
}

test("keeps the established compression thresholds", () => {
  assert.equal(ENTRY_COMPRESSION_MAX_RATIO, 0.9);
  assert.equal(AGGREGATE_COMPRESSION_MAX_RATIO, 0.75);
  assert.equal(LARGE_APPLICATION_ASSET_MINIMUM_BYTES_EXCLUSIVE, 1_024);
});

test("sums every successful local JavaScript and CSS candidate over 1 KiB", () => {
  const result = analyzeSyntheticStaticDelivery({
    networkRequests: validRequests([
      asset("route-87654321.js", {
        resourceSize: 2_000,
        transferSize: 1_000,
      }),
      asset("tiny-87654321.js", {
        resourceSize: 1_024,
        transferSize: 900,
      }),
      asset("missing-87654321.js", {
        statusCode: 404,
        resourceSize: 9_000,
        transferSize: 9_000,
      }),
      {
        ...asset("ignored-name.js", {
          resourceSize: 500,
          transferSize: 250,
        }),
        url: `${baseUrl}/bootstrap.js?v=1`,
      },
      {
        ...asset("foreign-87654321.js", {
          resourceSize: 500,
          transferSize: 250,
        }),
        url: "https://example.test/foreign.js",
      },
    ]),
    baseUrl,
    requiredEntryAssets,
  });

  assert.deepEqual(result.measuredLargeApplicationAssets, {
    scope: {
      origin: baseUrl,
      pathnamePrefix: "/assets/",
      fileExtensions: [".css", ".js"],
      statusCode: 200,
      cache: "none",
      minimumDecodedBytesExclusive: 1_024,
      minimumTransferredBytesExclusive: 0,
      usedForCompressionGate: true,
    },
    requestCount: 3,
    decodedBytes: 10_000,
    transferredBytes: 2_800,
    aggregateCompressionRatio: 0.28,
  });
  assert.deepEqual(result.observedAllSameOriginJavaScriptAndCss, {
    scope: {
      origin: baseUrl,
      pathnamePrefix: "/",
      fileExtensions: [".css", ".js"],
      statusCode: 200,
      cache: "any",
      minimumDecodedBytesExclusive: null,
      minimumTransferredBytesExclusive: null,
      usedForCompressionGate: false,
    },
    requestCount: 5,
    decodedBytes: 11_524,
    transferredBytes: 3_950,
    decodedBytesComplete: true,
    transferredBytesComplete: true,
  });
});

test("keeps incomplete all-asset observations out of the compression gate", () => {
  const result = analyzeSyntheticStaticDelivery({
    networkRequests: validRequests([
      asset("tiny-87654321.js", {
        resourceSize: 512,
        transferSize: undefined,
      }),
    ]),
    baseUrl,
    requiredEntryAssets,
  });

  assert.equal(result.measuredLargeApplicationAssets.requestCount, 2);
  assert.equal(result.measuredLargeApplicationAssets.decodedBytes, 8_000);
  assert.equal(result.measuredLargeApplicationAssets.transferredBytes, 1_800);
  assert.equal(
    result.measuredLargeApplicationAssets.aggregateCompressionRatio,
    0.225
  );
  assert.equal(result.observedAllSameOriginJavaScriptAndCss.requestCount, 3);
  assert.equal(
    result.observedAllSameOriginJavaScriptAndCss.decodedBytes,
    8_512
  );
  assert.equal(
    result.observedAllSameOriginJavaScriptAndCss.transferredBytes,
    null
  );
  assert.equal(
    result.observedAllSameOriginJavaScriptAndCss.transferredBytesComplete,
    false
  );
});

test("fails closed when a non-entry candidate came from cache", () => {
  assert.throws(
    () =>
      analyzeSyntheticStaticDelivery({
        networkRequests: validRequests([
          asset("route-87654321.js", {
            cache: "memory",
            transferSize: 100,
          }),
        ]),
        baseUrl,
        requiredEntryAssets,
      }),
    /route-87654321\.js.*cache=memory/
  );
});

test("fails closed when a non-entry candidate has no positive transfer", () => {
  for (const transferSize of [0, Number.NaN]) {
    assert.throws(
      () =>
        analyzeSyntheticStaticDelivery({
          networkRequests: validRequests([
            asset("route-87654321.js", { transferSize }),
          ]),
          baseUrl,
          requiredEntryAssets,
        }),
      /route-87654321\.js.*transferSize=/
    );
  }
});

test("uses every candidate when enforcing the aggregate ratio", () => {
  assert.throws(
    () =>
      analyzeSyntheticStaticDelivery({
        networkRequests: [
          asset("index-12345678.js", { transferSize: 3_500 }),
          asset("index-abcdefgh.css", { transferSize: 3_500 }),
          asset("route-87654321.js", {
            resourceSize: 4_000,
            transferSize: 3_000,
          }),
        ],
        baseUrl,
        requiredEntryAssets,
      }),
    /aggregateCompressionRatio=0\.833/
  );
});
