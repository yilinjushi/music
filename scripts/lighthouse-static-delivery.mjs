export const ENTRY_COMPRESSION_MAX_RATIO = 0.9;
export const AGGREGATE_COMPRESSION_MAX_RATIO = 0.75;
export const LARGE_APPLICATION_ASSET_MINIMUM_BYTES_EXCLUSIVE = 1024;

function isLocalJavaScriptOrCss(request, baseUrl) {
  return (
    typeof request?.url === "string" &&
    request.url.startsWith(`${baseUrl}/assets/`) &&
    /\.(?:css|js)$/.test(request.url) &&
    request.statusCode === 200
  );
}

function isSuccessfulSameOriginJavaScriptOrCss(request, baseUrl) {
  if (typeof request?.url !== "string" || request.statusCode !== 200) {
    return false;
  }
  try {
    const requestUrl = new URL(request.url);
    return (
      requestUrl.origin === new URL(baseUrl).origin &&
      /\.(?:css|js)$/i.test(requestUrl.pathname)
    );
  } catch {
    return false;
  }
}

function observedBytes(requests, field) {
  const complete = requests.every(
    (request) => Number.isFinite(request[field]) && request[field] >= 0
  );
  return {
    bytes: complete
      ? requests.reduce((total, request) => total + request[field], 0)
      : null,
    complete,
  };
}

function describeRequest(request) {
  return `${request.url} (cache=${String(request.cache)}, transferSize=${String(
    request.transferSize
  )})`;
}

export function analyzeSyntheticStaticDelivery({
  networkRequests,
  baseUrl,
  requiredEntryAssets,
}) {
  const largeApplicationAssets = networkRequests
    .filter((request) => isLocalJavaScriptOrCss(request, baseUrl))
    .filter(
      (request) =>
        Number.isFinite(request.resourceSize) &&
        request.resourceSize > LARGE_APPLICATION_ASSET_MINIMUM_BYTES_EXCLUSIVE
    );

  const invalidColdTransfers = largeApplicationAssets.filter(
    (request) =>
      request.cache !== "none" ||
      !Number.isFinite(request.transferSize) ||
      request.transferSize <= 0
  );
  if (invalidColdTransfers.length > 0) {
    throw new Error(
      `Lighthouse application assets were not cold-transferred: ${invalidColdTransfers
        .map(describeRequest)
        .join(", ")}`
    );
  }

  const requiredEntryRequests = requiredEntryAssets.map((asset) =>
    networkRequests.find(
      (request) => request.url === new URL(asset, baseUrl).href
    )
  );
  const entryCompressionObserved = requiredEntryRequests.every(
    (request) =>
      request?.statusCode === 200 &&
      request.cache === "none" &&
      Number.isFinite(request.resourceSize) &&
      Number.isFinite(request.transferSize) &&
      request.resourceSize > LARGE_APPLICATION_ASSET_MINIMUM_BYTES_EXCLUSIVE &&
      request.transferSize > 0 &&
      request.transferSize < request.resourceSize * ENTRY_COMPRESSION_MAX_RATIO
  );

  const decodedBytes = largeApplicationAssets.reduce(
    (total, request) => total + request.resourceSize,
    0
  );
  const transferredBytes = largeApplicationAssets.reduce(
    (total, request) => total + request.transferSize,
    0
  );
  const aggregateCompressionRatio =
    decodedBytes > 0 ? transferredBytes / decodedBytes : 1;

  if (
    !entryCompressionObserved ||
    aggregateCompressionRatio >= AGGREGATE_COMPRESSION_MAX_RATIO
  ) {
    throw new Error(
      `Lighthouse did not observe compressed synthetic static delivery: entryCompressionObserved=${entryCompressionObserved}, aggregateCompressionRatio=${aggregateCompressionRatio}`
    );
  }

  const allSameOriginJavaScriptAndCss = networkRequests.filter((request) =>
    isSuccessfulSameOriginJavaScriptOrCss(request, baseUrl)
  );
  const observedDecoded = observedBytes(
    allSameOriginJavaScriptAndCss,
    "resourceSize"
  );
  const observedTransferred = observedBytes(
    allSameOriginJavaScriptAndCss,
    "transferSize"
  );

  return {
    measuredLargeApplicationAssets: {
      scope: {
        origin: new URL(baseUrl).origin,
        pathnamePrefix: "/assets/",
        fileExtensions: [".css", ".js"],
        statusCode: 200,
        cache: "none",
        minimumDecodedBytesExclusive:
          LARGE_APPLICATION_ASSET_MINIMUM_BYTES_EXCLUSIVE,
        minimumTransferredBytesExclusive: 0,
        usedForCompressionGate: true,
      },
      requestCount: largeApplicationAssets.length,
      decodedBytes,
      transferredBytes,
      aggregateCompressionRatio,
    },
    observedAllSameOriginJavaScriptAndCss: {
      scope: {
        origin: new URL(baseUrl).origin,
        pathnamePrefix: "/",
        fileExtensions: [".css", ".js"],
        statusCode: 200,
        cache: "any",
        minimumDecodedBytesExclusive: null,
        minimumTransferredBytesExclusive: null,
        usedForCompressionGate: false,
      },
      requestCount: allSameOriginJavaScriptAndCss.length,
      decodedBytes: observedDecoded.bytes,
      transferredBytes: observedTransferred.bytes,
      decodedBytesComplete: observedDecoded.complete,
      transferredBytesComplete: observedTransferred.complete,
    },
  };
}
