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

registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [/^\/(?:api|music-api)(?:\/|\?|$)/],
  })
);
