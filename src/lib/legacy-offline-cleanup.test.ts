import { beforeEach, describe, expect, it, vi } from "vitest";
import { idbStorage } from "@/lib/storage-adapter";
import {
  clearLegacyOfflineArtifacts,
  clearRetiredSyncArtifacts,
} from "./legacy-offline-cleanup";

vi.mock("@/lib/storage-adapter", () => ({
  idbStorage: {
    removeItem: vi.fn(),
  },
}));

describe("clearLegacyOfflineArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(idbStorage.removeItem).mockResolvedValue(undefined);
    vi.stubGlobal("caches", { delete: vi.fn().mockResolvedValue(true) });
  });

  it("deletes the false offline record store and legacy audio cache", async () => {
    await clearLegacyOfflineArtifacts();

    expect(idbStorage.removeItem).toHaveBeenCalledWith("oh_offline_store");
    expect(caches.delete).toHaveBeenCalledWith("audio-stream-cache");
  });

  it("deletes retired sync credentials and their device key", async () => {
    localStorage.setItem("oh_sync_store", "legacy-encrypted-key");
    localStorage.setItem("__oh_dk__", "legacy-device-key");

    await clearRetiredSyncArtifacts();

    expect(idbStorage.removeItem).toHaveBeenCalledWith("oh_sync_store");
    expect(idbStorage.removeItem).toHaveBeenCalledWith("__oh_dk__");
    expect(localStorage.getItem("oh_sync_store")).toBeNull();
    expect(localStorage.getItem("__oh_dk__")).toBeNull();
  });
});
