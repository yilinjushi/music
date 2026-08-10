import { filterRequestHeaders } from "./headers";

export const MAX_PROXY_RESPONSE_BYTES = 150 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_CONNECTION_TIMEOUT_MS = 20_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;
const MAX_STREAM_DURATION_MS = 10 * 60_000;

export interface ProxyTimeoutOptions {
  connectionMs?: number;
  streamIdleMs?: number;
  streamTotalMs?: number;
  /** Absolute wall-clock deadline for acquiring accepted response headers. */
  deadlineAt?: number;
  /** Optional downstream cancellation propagated to the upstream request. */
  signal?: AbortSignal;
}

interface ResolvedProxyTimeouts {
  connectionMs: number;
  streamIdleMs: number;
  streamTotalMs: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}

const EXACT_PROXY_HOSTS = new Set([
  "music-api.gdstudio.xyz",
  // Migu publishes query-free lyric resources on this dedicated host. Keep
  // this exact so the broader migu.cn product zone never becomes proxyable.
  "lyric.migu.cn",
  // Verified against a live GD Joox resolver response. Keep the country/CDN
  // label exact instead of allowing the broader joox.com parent zone.
  "hk.stream.music.joox.com",
]);

// Only provider-owned CDN zones are eligible for suffix matching. Broad
// company zones (qq.com, bilibili.com, kugou.com, etc.) are intentionally not
// accepted because they would turn this endpoint into a relay for unrelated
// products on the same parent domain.
const PROXY_HOST_SUFFIXES = [
  "music.126.net",
  "kwcdn.kuwo.cn",
  "kgimg.com",
  "musicapp.migu.cn",
  "bilivideo.com",
  "hdslb.com",
  "biliimg.com",
];

const PROXY_HOST_PATTERNS = [
  /^(?:bd-[a-z0-9-]+|other\.[a-z0-9.-]+|star)\.kuwo\.cn$/,
  /^(?:webfs|trackercdn|fs|audio|mobilecdn|imge|imgessl)(?:\.[a-z0-9-]+)*\.kugou\.com$/,
  /^(?:isure\d*|ws|dl)\.stream\.qqmusic\.qq\.com$/,
  /^(?:y|qpic)\.gtimg\.cn$/,
  /^(?:freetyst|app)\.nf\.migu\.cn$/,
];

const ALLOWED_CONTENT_TYPES = [
  /^audio\/(?:aac|flac|mpeg|mp4|ogg|wav|webm|x-m4a|x-wav)(?:;|$)/i,
  /^image\/(?:avif|bmp|gif|jpeg|png|webp)(?:;|$)/i,
  /^video\/(?:mp4|webm)(?:;|$)/i,
  /^application\/(?:octet-stream|json|vnd\.apple\.mpegurl)(?:;|$)/i,
  /^text\/plain(?:;|$)/i,
];

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

export function isAllowedProxyHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (EXACT_PROXY_HOSTS.has(normalized)) return true;
  return (
    PROXY_HOST_SUFFIXES.some(
      (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`)
    ) || PROXY_HOST_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export function normalizeProxyTarget(urlString: string): URL | null {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.port && url.port !== "443") return null;

    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      !hostname ||
      isIpLiteral(hostname) ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      !isAllowedProxyHost(hostname)
    ) {
      return null;
    }

    url.hostname = hostname;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function isValidUrl(urlString: string): boolean {
  return normalizeProxyTarget(urlString) !== null;
}

export function assertProxyResponse(response: Response): void {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const bytes = Number(contentLength);
    if (
      !Number.isFinite(bytes) ||
      bytes < 0 ||
      bytes > MAX_PROXY_RESPONSE_BYTES
    ) {
      throw new Error("Proxy response exceeds size limit");
    }
  }

  const contentType = response.headers.get("content-type")?.trim() || "";
  if (!contentType) {
    throw new Error("Proxy response Content-Type is required");
  }
  if (!ALLOWED_CONTENT_TYPES.some((pattern) => pattern.test(contentType))) {
    throw new Error("Proxy response type is not allowed");
  }
}

function boundedTimeout(
  value: number | undefined,
  fallback: number,
  maximum: number
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(value), maximum);
}

function resolveTimeouts(
  timeout: number | ProxyTimeoutOptions
): ResolvedProxyTimeouts {
  const options =
    typeof timeout === "number" ? { connectionMs: timeout } : timeout;
  if (
    options.deadlineAt !== undefined &&
    (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= 0)
  ) {
    throw new TypeError("Proxy deadline must be a positive finite timestamp");
  }
  return {
    connectionMs: boundedTimeout(
      options.connectionMs,
      DEFAULT_CONNECTION_TIMEOUT_MS,
      MAX_STREAM_DURATION_MS
    ),
    streamIdleMs: boundedTimeout(
      options.streamIdleMs,
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      DEFAULT_STREAM_IDLE_TIMEOUT_MS
    ),
    streamTotalMs: boundedTimeout(
      options.streamTotalMs,
      MAX_STREAM_DURATION_MS,
      MAX_STREAM_DURATION_MS
    ),
    deadlineAt:
      options.deadlineAt === undefined
        ? undefined
        : Math.trunc(options.deadlineAt),
    signal: options.signal,
  };
}

async function fetchWithHeaderTimeout(
  url: URL,
  headers: Record<string, string>,
  abortController: AbortController,
  timeouts: Pick<ResolvedProxyTimeouts, "connectionMs" | "deadlineAt">
): Promise<Response> {
  const deadlineRemainingMs =
    timeouts.deadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : timeouts.deadlineAt - Date.now();
  if (deadlineRemainingMs <= 0) {
    abortController.abort();
    throw new Error("Proxy request deadline exceeded");
  }
  const deadlineLimited = deadlineRemainingMs <= timeouts.connectionMs;
  const timeoutMs = Math.min(timeouts.connectionMs, deadlineRemainingMs);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(
        new Error(
          deadlineLimited
            ? "Proxy request deadline exceeded"
            : "Proxy connection timed out"
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetch(url.toString(), {
        method: "GET",
        headers: filterRequestHeaders(new Headers(headers)),
        redirect: "manual",
        signal: abortController.signal,
      }),
      timedOut,
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function limitResponseStream(
  response: Response,
  abortController: AbortController,
  timeouts: Pick<ResolvedProxyTimeouts, "streamIdleMs" | "streamTotalMs">,
  onFinished: () => void = () => undefined
): Response {
  if (!response.body) {
    onFinished();
    return response;
  }

  const reader = response.body.getReader();
  let receivedBytes = 0;
  let finished = false;
  let terminalError: Error | null = null;
  let idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let activeReadReject: ((error: Error) => void) | null = null;

  const clearIdleTimeout = () => {
    if (idleTimeoutId === null) return;
    clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  };

  let totalTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const clearAllTimeouts = () => {
    clearIdleTimeout();
    if (totalTimeoutId !== null) {
      clearTimeout(totalTimeoutId);
      totalTimeoutId = null;
    }
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    clearAllTimeouts();
    onFinished();
  };

  const terminate = (error: Error) => {
    if (finished) return;
    terminalError = error;
    finished = true;
    clearAllTimeouts();
    onFinished();
    abortController.abort();
    activeReadReject?.(error);
    activeReadReject = null;
    void reader.cancel(error.message).catch(() => undefined);
  };

  // The absolute stream budget begins as soon as the accepted final response
  // headers arrive, before the first downstream body read.
  totalTimeoutId = setTimeout(() => {
    terminate(new Error("Proxy response stream exceeded total duration"));
  }, timeouts.streamTotalMs);

  const readNextChunk = async (): Promise<
    ReadableStreamReadResult<Uint8Array>
  > => {
    if (terminalError) throw terminalError;

    let rejectThisRead: ((error: Error) => void) | null = null;
    const idleTimeout = new Promise<never>((_, reject) => {
      rejectThisRead = reject;
      activeReadReject = reject;
      idleTimeoutId = setTimeout(() => {
        terminate(new Error("Proxy response stream became idle"));
      }, timeouts.streamIdleMs);
    });

    try {
      return await Promise.race([reader.read(), idleTimeout]);
    } finally {
      clearIdleTimeout();
      if (activeReadReject === rejectThisRead) activeReadReject = null;
    }
  };

  const limitedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (terminalError) {
        controller.error(terminalError);
        return;
      }

      try {
        const { done, value } = await readNextChunk();
        if (done) {
          finish();
          controller.close();
          return;
        }

        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_PROXY_RESPONSE_BYTES) {
          const error = new Error("Proxy response exceeds size limit");
          terminate(error);
          controller.error(error);
          return;
        }
        controller.enqueue(value);
      } catch {
        const error =
          terminalError || new Error("Proxy response stream failed");
        terminate(error);
        controller.error(error);
      }
    },
    async cancel() {
      finish();
      abortController.abort();
      await reader.cancel("Proxy downstream cancelled").catch(() => undefined);
    },
  });

  return new Response(limitedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Fetch an approved media/provider URL. Redirects are followed manually so
 * every hop is subject to the same host, protocol and credential checks.
 */
export async function safeFetch(
  url: string,
  headers: Record<string, string>,
  timeout: number | ProxyTimeoutOptions = DEFAULT_CONNECTION_TIMEOUT_MS
): Promise<Response> {
  let current = normalizeProxyTarget(url);
  if (!current) {
    throw new Error("Invalid or unapproved proxy target");
  }

  const controller = new AbortController();
  const timeouts = resolveTimeouts(timeout);
  const callerSignal = timeouts.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  const detachCallerSignal = () =>
    callerSignal?.removeEventListener("abort", abortFromCaller);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    for (
      let redirectCount = 0;
      redirectCount <= MAX_REDIRECTS;
      redirectCount += 1
    ) {
      const response = await fetchWithHeaderTimeout(
        current,
        headers,
        controller,
        timeouts
      );

      if (response.status < 300 || response.status >= 400) {
        if (
          timeouts.deadlineAt !== undefined &&
          Date.now() >= timeouts.deadlineAt
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("Proxy request deadline exceeded");
        }
        assertProxyResponse(response);
        return limitResponseStream(
          response,
          controller,
          timeouts,
          detachCallerSignal
        );
      }

      if (redirectCount === MAX_REDIRECTS) {
        throw new Error("Proxy redirect limit exceeded");
      }

      const location = response.headers.get("location");
      if (!location) throw new Error("Proxy redirect is missing Location");
      const next = normalizeProxyTarget(new URL(location, current).toString());
      if (!next) throw new Error("Proxy redirect target is not allowed");
      // Initiate cancellation without waiting on an untrusted redirect body;
      // the next hop receives its own connection/header deadline.
      void response.body?.cancel().catch(() => undefined);
      current = next;
    }

    throw new Error("Proxy redirect limit exceeded");
  } catch (error) {
    detachCallerSignal();
    controller.abort();
    throw error;
  }
}
