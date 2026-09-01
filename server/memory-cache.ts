import type { ApiResponseCache } from "../functions/types/hono";

interface CacheEntry {
  body: Uint8Array;
  headers: Array<[string, string]>;
  status: number;
  statusText: string;
  expiresAt: number;
}

interface MemoryCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxItemBytes?: number;
  maxTtlMs?: number;
}

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ITEM_BYTES = 1024 * 1024;
const DEFAULT_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cacheKey(request: Request): string {
  return request.url;
}

function responseTtlMs(response: Response, maxTtlMs: number): number {
  const match = response.headers
    .get("cache-control")
    ?.match(/(?:^|,)\s*max-age=(\d+)/i);
  const requested = match ? Number(match[1]) * 1000 : 0;
  if (!Number.isFinite(requested) || requested <= 0) return maxTtlMs;
  return Math.min(maxTtlMs, requested);
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("cache item too large").catch(() => undefined);
        throw new Error("Cache item exceeds the bounded size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Bounded, restart-cold Cache API replacement for ordinary JSON responses. */
export class MemoryResponseCache implements ApiResponseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxItemBytes: number;
  private readonly maxTtlMs: number;

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxItemBytes = options.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES;
    this.maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
    if (
      !Number.isInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      !Number.isInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      !Number.isInteger(this.maxItemBytes) ||
      this.maxItemBytes < 1 ||
      !Number.isInteger(this.maxTtlMs) ||
      this.maxTtlMs < 1
    ) {
      throw new TypeError("Invalid memory cache bounds");
    }
  }

  async match(request: Request): Promise<Response | null> {
    const key = cacheKey(request);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      await this.delete(request);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return new Response(new Uint8Array(entry.body), {
      status: entry.status,
      statusText: entry.statusText,
      headers: entry.headers,
    });
  }

  async put(request: Request, response: Response): Promise<void> {
    const body = await readBoundedBody(response, this.maxItemBytes);
    if (body.byteLength > this.maxBytes) return;
    const key = cacheKey(request);
    const previous = this.entries.get(key);
    if (previous) this.totalBytes -= previous.body.byteLength;
    this.entries.delete(key);

    this.entries.set(key, {
      body,
      headers: (() => {
        const headers: Array<[string, string]> = [];
        response.headers.forEach((value, name) => headers.push([name, value]));
        return headers;
      })(),
      status: response.status,
      statusText: response.statusText,
      expiresAt: Date.now() + responseTtlMs(response, this.maxTtlMs),
    });
    this.totalBytes += body.byteLength;
    this.evict();
  }

  async delete(request: Request): Promise<boolean> {
    const key = cacheKey(request);
    const previous = this.entries.get(key);
    if (!previous) return false;
    this.entries.delete(key);
    this.totalBytes -= previous.body.byteLength;
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private evict(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) return;
      const entry = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (entry) this.totalBytes -= entry.body.byteLength;
    }
  }
}
