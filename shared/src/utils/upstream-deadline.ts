export const MUSIC_UPSTREAM_DEADLINE_MS = 12_000;

export const UPSTREAM_BODY_LIMIT_BYTES = {
  json: 8 * 1024 * 1024,
  text: 8 * 1024 * 1024,
  binary: 4 * 1024 * 1024,
  none: 0,
} as const;

export type UpstreamResponseType = keyof typeof UPSTREAM_BODY_LIMIT_BYTES;

export class UpstreamDeadlineError extends Error {
  constructor() {
    super("Music upstream deadline exceeded");
    this.name = "UpstreamDeadlineError";
  }
}

export class UpstreamBodyLimitError extends Error {
  constructor() {
    super("Music upstream response body exceeded its byte limit");
    this.name = "UpstreamBodyLimitError";
  }
}

export interface UpstreamDeadlineOptions {
  responseType: UpstreamResponseType;
  deadlineMs?: number;
  fetcher?: typeof fetch;
}

function parseContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw.trim())) throw new UpstreamBodyLimitError();
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new UpstreamBodyLimitError();
  }
  return length;
}

function preserveResponseMetadata(source: Response, target: Response): void {
  // A reconstructed Response otherwise loses redirect metadata used by short
  // link handlers. These properties are observational only for the reader.
  Object.defineProperties(target, {
    url: { configurable: true, value: source.url },
    redirected: { configurable: true, value: source.redirected },
    type: { configurable: true, value: source.type },
  });
}

async function bufferBoundedResponse(
  response: Response,
  responseType: Exclude<UpstreamResponseType, "none">,
  onReader: (reader: ReadableStreamDefaultReader<Uint8Array> | null) => void
): Promise<Response> {
  const limit = UPSTREAM_BODY_LIMIT_BYTES[responseType];
  const declaredLength = parseContentLength(response);
  if (declaredLength !== null && declaredLength > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamBodyLimitError();
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  onReader(reader);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > limit) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamBodyLimitError();
      }
      chunks.push(result.value);
    }
  } finally {
    onReader(null);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const bounded = new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  preserveResponseMetadata(response, bounded);
  return bounded;
}

/**
 * Runs both the upstream fetch and its response-body reader under one absolute
 * deadline. The reader is intentionally required so callers cannot
 * accidentally stop the timer after response headers while a body stalls.
 */
export async function fetchUpstreamWithDeadline<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  read: (response: Response) => Promise<T> | T,
  options: UpstreamDeadlineOptions
): Promise<T> {
  const deadlineMs = options.deadlineMs ?? MUSIC_UPSTREAM_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new TypeError("Upstream deadline must be a positive finite number");
  }

  const controller = new AbortController();
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  let timedOut = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      void activeReader?.cancel().catch(() => undefined);
      reject(new UpstreamDeadlineError());
    }, deadlineMs);
  });

  const operation = Promise.resolve()
    .then(() =>
      (options.fetcher ?? fetch)(input, {
        ...init,
        signal: controller.signal,
      })
    )
    .then(async (response) => {
      if (options.responseType === "none") {
        try {
          return await read(response);
        } finally {
          // Header-only/HEAD callers must not leave an unconsumed upstream
          // response attached to the Worker after their callback returns.
          await response.body?.cancel().catch(() => undefined);
        }
      }
      const bounded = await bufferBoundedResponse(
        response,
        options.responseType,
        (reader) => {
          activeReader = reader;
        }
      );
      return read(bounded);
    });

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (timedOut) throw new UpstreamDeadlineError();
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
