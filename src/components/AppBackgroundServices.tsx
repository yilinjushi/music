import { useEffect } from "react";
import { useDownloadStore } from "@/store/download-store";
import {
  cleanupCache,
  purgeLegacyNeteaseDataCache,
  purgeLegacyResolvedUrlCache,
} from "@/lib/utils/cache";
import { revokeAll } from "@/lib/utils/blob-registry";
import { clearLegacyOfflineArtifacts } from "@/lib/legacy-offline-cleanup";

/**
 * Non-visual startup work that is intentionally loaded after the first paint.
 * Keeping it outside App's static graph prevents download helpers and cache
 * maintenance from delaying the first usable route.
 */
export function AppBackgroundServices() {
  useEffect(() => {
    useDownloadStore.getState().init();
    void clearLegacyOfflineArtifacts();
    void purgeLegacyResolvedUrlCache();
    void purgeLegacyNeteaseDataCache();

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(() => cleanupCache());
    } else {
      setTimeout(() => cleanupCache(), 5000);
    }

    const handleBeforeUnload = () => revokeAll();
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      revokeAll();
    };
  }, []);

  return null;
}
