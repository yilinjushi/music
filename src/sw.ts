/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  matchPrecache,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare let self: ServiceWorkerGlobalScope;

const APP_SHELL_URL = "/index.html";
const LEGACY_RUNTIME_CACHES = ["pages-cache", "audio-stream-cache"];
let userApprovedActivation = false;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Only a user-confirmed update may activate a waiting worker. The page keeps
// this action disabled while audio is playing, so an update cannot interrupt a
// listening session.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    userApprovedActivation = true;
    event.waitUntil(self.skipWaiting());
  }
});

// Remove caches created by the upstream runtime strategy. Audio is deliberately
// network-only here: caching arbitrary 200/206 streams can turn a partial range
// into a corrupt "complete" track.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(
        LEGACY_RUNTIME_CACHES.map((name) => caches.delete(name))
      );
      // Claim only when the waiting worker received the explicit update
      // message. A first installation must not seize already-open tabs.
      if (userApprovedActivation) await self.clients.claim();
    })()
  );
});

const navigationHandler = async ({
  event,
}: {
  event: ExtendableEvent;
}): Promise<Response> => {
  const request = (event as FetchEvent).request;

  try {
    return await fetch(request);
  } catch {
    const appShell = await matchPrecache(APP_SHELL_URL);
    return appShell ?? Response.error();
  }
};

// Songs stored on the phone (see src/lib/offline-audio.ts) are served here
// with byte-range support, so the media element reads small slices on demand
// instead of holding the whole file as a blob: URL (WebKit can spin on those).
const OFFLINE_AUDIO_CACHE = "offline-audio-v1";
const OFFLINE_AUDIO_ROUTE = "/offline-audio";
const CACHED_AUDIO_PATH = "/music-api/cache/audio?key=";

// The media element sends many range requests per song; keep the last two
// songs' blobs so each slice does not reopen the cache entry.
const recentBlobs = new Map<string, Blob>();

async function storedBlob(key: string): Promise<Blob | null> {
  const hit = recentBlobs.get(key);
  if (hit) return hit;
  const cache = await caches.open(OFFLINE_AUDIO_CACHE);
  const cached = await cache.match(`${CACHED_AUDIO_PATH}${key}`);
  if (!cached) return null;
  const blob = await cached.blob();
  recentBlobs.set(key, blob);
  while (recentBlobs.size > 2) {
    recentBlobs.delete(recentBlobs.keys().next().value!);
  }
  return blob;
}

async function offlineAudioResponse(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  // Lets the page confirm this worker (not an older one) owns the route.
  if (params.has("probe")) {
    return new Response(null, {
      status: 204,
      headers: { "X-Offline-Audio": "1" },
    });
  }
  const key = params.get("key") ?? "";
  if (!/^[0-9a-f]{64}$/.test(key)) return new Response(null, { status: 404 });
  const blob = await storedBlob(key);
  if (!blob || blob.size === 0) return new Response(null, { status: 404 });
  const type = blob.type || "audio/mpeg";
  const size = blob.size;
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes" };

  const range = /^bytes=(\d*)-(\d*)$/.exec(
    request.headers.get("Range")?.trim() ?? ""
  );
  if (!range) {
    return new Response(blob, {
      status: 200,
      headers: { ...headers, "Content-Length": String(size) },
    });
  }
  let start: number;
  let end: number;
  if (range[1] === "") {
    const suffix = Number(range[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
  }
  if (!(start <= end) || start >= size) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }
  return new Response(blob.slice(start, end + 1, type), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
    },
  });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method === "GET" &&
    url.origin === self.location.origin &&
    url.pathname === OFFLINE_AUDIO_ROUTE
  ) {
    event.respondWith(offlineAudioResponse(event.request));
  }
});

registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [/^\/(?:api|music-api)(?:\/|\?|$)/],
  })
);
