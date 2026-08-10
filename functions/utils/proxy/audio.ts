import { safeFetch, type ProxyTimeoutOptions } from "./fetch";

const PRIVATE_NO_STORE = "private, no-store, max-age=0";
const AUDIO_MIME_ESSENCE =
  /^(?:audio\/[a-z0-9!#$&^_.+-]+|video\/mp4|application\/octet-stream)$/;
const SINGLE_BYTE_RANGE = /^bytes=(\d{1,20})-(\d{0,20})$|^bytes=-(\d{1,20})$/;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

/** Only a single, bounded byte-range syntax is accepted from the browser. */
export function isValidAudioRange(range: string | null | undefined): boolean {
  if (range === null || range === undefined) return true;
  if (range.length > 64) return false;
  const match = SINGLE_BYTE_RANGE.exec(range);
  if (!match) return false;

  if (match[3] !== undefined) return BigInt(match[3]) > 0n;
  const start = BigInt(match[1]);
  return match[2] === "" || start <= BigInt(match[2]);
}

function normalizeAudioContentType(value: string): string | null {
  const essence = value.split(";", 1)[0].trim().toLowerCase();
  return AUDIO_MIME_ESSENCE.test(essence) ? essence : null;
}

function normalizeContentLength(value: string | null): string | null {
  if (!value || !/^\d{1,20}$/.test(value)) return null;
  return BigInt(value).toString();
}

function normalizeContentRange(value: string): string | null {
  const match = CONTENT_RANGE.exec(value);
  if (!match) return null;
  const start = BigInt(match[1]);
  const end = BigInt(match[2]);
  if (start > end) return null;
  const total = match[3] === "*" ? "*" : BigInt(match[3]).toString();
  if (total !== "*" && end >= BigInt(total)) return null;
  return `bytes ${start.toString()}-${end.toString()}/${total}`;
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * Streams an approved provider media URL without exposing the URL itself.
 * safeFetch enforces HTTPS, per-hop host allowlists, size limits and bounded
 * connection/idle/absolute deadlines. This wrapper narrows the accepted
 * response to audio and replaces every cache/security header.
 */
export async function proxyPrivateAudio(
  upstreamUrl: string,
  providerHeaders: Record<string, string>,
  range?: string | null,
  timeout?: ProxyTimeoutOptions
): Promise<Response> {
  if (!isValidAudioRange(range)) throw new Error("Invalid audio range");
  const hasControlCharacter = [...upstreamUrl].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    upstreamUrl.length > 4096 ||
    upstreamUrl !== upstreamUrl.trim() ||
    hasControlCharacter
  ) {
    throw new Error("Invalid audio target");
  }

  const target = new URL(upstreamUrl);
  if (target.protocol === "http:") target.protocol = "https:";
  const headers = { ...providerHeaders };
  if (range) headers.Range = range;

  const response = await safeFetch(target.toString(), headers, timeout);
  if (response.status !== 200 && response.status !== 206) {
    cancelBody(response);
    throw new Error("Audio upstream status is not allowed");
  }

  const contentType = normalizeAudioContentType(
    response.headers.get("Content-Type") || ""
  );
  if (!contentType) {
    cancelBody(response);
    throw new Error("Audio upstream type is not allowed");
  }

  const upstreamContentRange = response.headers.get("Content-Range");
  const contentRange =
    response.status === 206 && upstreamContentRange
      ? normalizeContentRange(upstreamContentRange)
      : null;
  if (response.status === 206 && !contentRange) {
    cancelBody(response);
    throw new Error("Audio upstream range is invalid");
  }

  const responseHeaders = new Headers();
  // Reconstruct every forwarded header from a validated canonical value. No
  // arbitrary upstream parameter or formatting survives as a side channel.
  responseHeaders.set("Content-Type", contentType);
  const contentLength = normalizeContentLength(
    response.headers.get("Content-Length")
  );
  if (contentLength) responseHeaders.set("Content-Length", contentLength);
  if (contentRange) responseHeaders.set("Content-Range", contentRange);
  if (response.headers.get("Accept-Ranges")?.trim().toLowerCase() === "bytes") {
    responseHeaders.set("Accept-Ranges", "bytes");
  }
  responseHeaders.set("Cache-Control", PRIVATE_NO_STORE);
  responseHeaders.set("Pragma", "no-cache");
  responseHeaders.set("Vary", "Range");
  responseHeaders.set("X-Content-Type-Options", "nosniff");

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}
