/**
 * Cover images kept in Cache Storage on the phone, so a song that plays from
 * the phone can show its cover without waking the network.
 */
const COVER_CACHE = "cover-images-v1";
const MAX_LIVE_BLOB_URLS = 4;

const liveBlobUrls = new Map<string, string>();
const storing = new Set<string>();

function isCacheable(url: string): boolean {
  return typeof caches !== "undefined" && url.startsWith("https://");
}

/** A blob: URL for a cover already stored on the phone, else null. */
export async function getStoredCoverUrl(url: string): Promise<string | null> {
  if (!isCacheable(url)) return null;
  const existing = liveBlobUrls.get(url);
  if (existing) return existing;
  try {
    const cache = await caches.open(COVER_CACHE);
    const response = await cache.match(url);
    if (!response) return null;
    const blob = await response.blob();
    if (blob.size === 0) return null;
    const blobUrl = URL.createObjectURL(blob);
    liveBlobUrls.set(url, blobUrl);
    while (liveBlobUrls.size > MAX_LIVE_BLOB_URLS) {
      const [oldKey, oldUrl] = liveBlobUrls.entries().next().value!;
      liveBlobUrls.delete(oldKey);
      URL.revokeObjectURL(oldUrl);
    }
    return blobUrl;
  } catch {
    return null;
  }
}

/** NetEase's image CDN can resize; a phone-sized copy is plenty. */
function downloadUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".music.126.net") && !parsed.search) {
      return `${url}?param=500y500`;
    }
  } catch {
    // Fall through to the original link.
  }
  return url;
}

/**
 * Store every missing cover on the phone, one at a time. Covers already
 * stored are skipped, so repeated calls only download what is new.
 */
export async function storeCovers(
  urls: string[],
  shouldContinue: () => boolean
): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(COVER_CACHE);
    const stored = new Set((await cache.keys()).map((request) => request.url));
    for (const url of new Set(urls)) {
      if (!shouldContinue()) return;
      if (!isCacheable(url) || stored.has(new URL(url).href)) continue;
      await storeCover(url);
    }
  } catch {
    // Covers are optional.
  }
}

/** Store a cover on the phone (best effort, once per session per cover). */
export async function storeCover(url: string): Promise<void> {
  if (!isCacheable(url) || storing.has(url)) return;
  storing.add(url);
  try {
    const cache = await caches.open(COVER_CACHE);
    if (await cache.match(url)) return;
    const response = await fetch(downloadUrl(url), { mode: "cors" });
    if (response.status === 200) await cache.put(url, response);
  } catch {
    // CDN without CORS, quota full, etc.: covers are optional.
    storing.delete(url);
  }
}
