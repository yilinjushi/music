import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { storeKey } from "./store-keys";
import { createSanitizingStateStorage } from "@/lib/storage-adapter";
import type { UserProfile } from "@/lib/netease/netease-types";
import {
  containsSensitiveData,
  validatePersistableResourceReference,
} from "@/lib/utils/sensitive-data";
import { normalizePersistableResourceUrl } from "@shared/utils/url";

// Remove credentials written by releases that predated server-side sessions.
// This is intentionally best-effort because storage can be unavailable in
// private browsing or during server-side tests.
try {
  localStorage.removeItem("cookie:netease");
  localStorage.removeItem("cookie:_netease");
} catch {
  // no-op
}

interface NeteaseState {
  authenticated: boolean;
  user: UserProfile | null;
}

interface NeteaseActions {
  setSession: (user: UserProfile) => void;
  clearSession: () => void;
}

function sanitizeUserProfile(value: unknown): UserProfile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const profile = value as Record<string, unknown>;
  const rawAvatarUrl =
    typeof profile.avatarUrl === "string" ? profile.avatarUrl : null;
  const avatarUrl =
    rawAvatarUrl === null ? "" : normalizePersistableResourceUrl(rawAvatarUrl);
  if (
    typeof profile.userId !== "number" ||
    !Number.isSafeInteger(profile.userId) ||
    profile.userId < 0 ||
    typeof profile.nickname !== "string" ||
    profile.nickname.length > 256 ||
    containsSensitiveData(profile.nickname) ||
    rawAvatarUrl === null ||
    (rawAvatarUrl.trim() !== "" && !avatarUrl) ||
    !validatePersistableResourceReference(avatarUrl)
  ) {
    return null;
  }

  // The UI needs only these three fields. Do not persist the raw upstream
  // profile: it can grow credential-shaped or provider-private fields later.
  return {
    userId: profile.userId,
    nickname: profile.nickname,
    avatarUrl,
  };
}

export function sanitizePersistedNeteaseState(value: unknown): NeteaseState {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const user = sanitizeUserProfile(record.user);
  return { authenticated: Boolean(user), user };
}

export const NETEASE_STORE_VERSION = 3;

export function createNeteaseStateStorage(
  baseStorage: StateStorage
): StateStorage {
  return createSanitizingStateStorage(baseStorage, {
    version: NETEASE_STORE_VERSION,
    sanitize: sanitizePersistedNeteaseState,
  });
}

export const useNeteaseStore = create<NeteaseState & NeteaseActions>()(
  persist<NeteaseState & NeteaseActions, [], [], NeteaseState>(
    (set) => ({
      authenticated: false,
      user: null,
      setSession: (user) => set(sanitizePersistedNeteaseState({ user })),
      clearSession: () => set({ authenticated: false, user: null }),
    }),
    {
      name: storeKey.NeteaseStore,
      storage: createJSONStorage(() => createNeteaseStateStorage(localStorage)),
      version: NETEASE_STORE_VERSION,
      migrate: sanitizePersistedNeteaseState,
      merge: (persisted, current) => ({
        ...current,
        ...sanitizePersistedNeteaseState(persisted),
      }),
      partialize: sanitizePersistedNeteaseState,
    }
  )
);
