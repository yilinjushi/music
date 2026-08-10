import { create } from "zustand";
import { storeKey } from "./store-keys";
import { idbStorage } from "@/lib/storage-adapter";
import { revokeBlobUrl } from "@/lib/utils/blob-registry";
import type { MusicSource } from "@/types/music";
import { v5 as uuidv5 } from "uuid";
import { stringContainsSensitiveAssignment } from "@/lib/utils/sensitive-data";
import { getTrackIdentityKey } from "@/lib/utils/track-identity";

const URL_CACHE_NAMESPACE = "f6d1e153-0e4b-4a77-94ef-f64cf06a1c87";

function opaqueCacheIdentifier(value: string): string {
  return uuidv5(value, URL_CACHE_NAMESPACE);
}

function isSafeCacheValue(value: string): boolean {
  if (value.length > 16 * 1024 || stringContainsSensitiveAssignment(value)) {
    return false;
  }
  try {
    const parsed = new URL(value, "https://cache.invalid");
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * 构建 URL 缓存 key
 * @param source 音源
 * @param trackId 曲目目录 ID
 * @param urlId 曲目 URL 标识；非本地源也属于完整曲目身份
 * @param quality 音质档位
 * @returns 不暴露原始标识的完整曲目身份缓存 key
 */
export function buildUrlCacheKey(
  source: MusicSource,
  trackId: string,
  urlId: string | undefined,
  quality: string
): string {
  const playableIdentity =
    source === "local" || source === "url"
      ? (urlId ?? trackId)
      : getTrackIdentityKey({ id: trackId, source, url_id: urlId });
  if (
    stringContainsSensitiveAssignment(trackId) ||
    stringContainsSensitiveAssignment(urlId ?? "") ||
    stringContainsSensitiveAssignment(quality)
  ) {
    throw new Error("拒绝为包含敏感数据的 URL 建立缓存");
  }
  const safeId = `opaque:${opaqueCacheIdentifier(playableIdentity)}`;
  return `${source}:${safeId}:${quality}`;
}

function normalizeCacheKey(key: string): string | null {
  if (key.length > 2048 || stringContainsSensitiveAssignment(key)) {
    return null;
  }
  if (key.startsWith("url:opaque:") || key.startsWith("local:opaque:")) {
    return key;
  }

  for (const source of ["url", "local"] as const) {
    const prefix = `${source}:`;
    if (!key.startsWith(prefix)) continue;
    const qualitySeparator = key.lastIndexOf(":");
    if (qualitySeparator <= prefix.length) return null;
    const rawId = key.slice(prefix.length, qualitySeparator);
    const quality = key.slice(qualitySeparator + 1);
    return buildUrlCacheKey(source, rawId, rawId, quality);
  }

  if (key.includes("://")) {
    return `legacy:opaque:${opaqueCacheIdentifier(key)}`;
  }
  return key;
}

export async function purgeLegacyPersistedUrlCache(): Promise<void> {
  try {
    await idbStorage.removeItem(storeKey.UrlCacheStore);
  } catch {
    // Private browsing can disable IndexedDB; the live store is still memory-only.
  }
}

// Previous releases persisted resolved/signed URLs. Purge that legacy state as
// soon as this module is loaded; clear() repeats the purge on logout and 401.
void purgeLegacyPersistedUrlCache();

/**
 * 已解析音频 URL 的仅内存缓存状态
 */
interface UrlCacheState {
  /** URL 映射表，key 由完整曲目身份和音质生成 */
  urlMap: Record<string, string>;

  /**
   * Monotonic write generation. A resolver captures this value before its
   * request starts and may only populate the cache while the generation is
   * still current. clear()/delete() advance it synchronously so logout, 401
   * cleanup and explicit invalidation cannot be undone by an older request.
   */
  generation: number;

  /** 获取指定 key 的缓存 URL */
  get: (key: string) => string | undefined;

  /** 仅在内存中缓存 URL；若覆盖旧 blob URL 则先释放 */
  set: (key: string, value: string) => void;

  /** 仅在 generation 未变化时写入，返回是否取得写租约 */
  setIfCurrentGeneration: (
    key: string,
    value: string,
    generation: number
  ) => boolean;

  /** 删除缓存 URL；若为 blob URL 则先释放 */
  delete: (key: string) => void;

  /** 清空所有缓存 URL；若包含 blob URL 则先释放 */
  clear: () => Promise<void>;
}

export const useUrlCacheStore = create<UrlCacheState>()((set, storeGet) => ({
  urlMap: {},
  generation: 0,

  get: (key) => {
    const safeKey = normalizeCacheKey(key);
    return safeKey ? storeGet().urlMap[safeKey] : undefined;
  },

  set: (key, value) => {
    const safeKey = normalizeCacheKey(key);
    if (!safeKey || !isSafeCacheValue(value)) return;
    set((state) => {
      const old = state.urlMap[safeKey];
      if (old && old !== value && old.startsWith("blob:")) {
        revokeBlobUrl(old);
      }
      return { urlMap: { ...state.urlMap, [safeKey]: value } };
    });
  },

  setIfCurrentGeneration: (key, value, generation) => {
    const safeKey = normalizeCacheKey(key);
    if (!safeKey || !isSafeCacheValue(value)) return false;

    let written = false;
    set((state) => {
      if (state.generation !== generation) return state;
      const old = state.urlMap[safeKey];
      if (old && old !== value && old.startsWith("blob:")) {
        revokeBlobUrl(old);
      }
      written = true;
      return { urlMap: { ...state.urlMap, [safeKey]: value } };
    });
    return written;
  },

  delete: (key) => {
    const safeKey = normalizeCacheKey(key);
    if (!safeKey) return;
    set((state) => {
      const old = state.urlMap[safeKey];
      if (old?.startsWith("blob:")) {
        revokeBlobUrl(old);
      }
      const { [safeKey]: _, ...rest } = state.urlMap;
      return { urlMap: rest, generation: state.generation + 1 };
    });
  },

  clear: async () => {
    set((state) => {
      for (const url of Object.values(state.urlMap)) {
        if (url.startsWith("blob:")) revokeBlobUrl(url);
      }
      return { urlMap: {}, generation: state.generation + 1 };
    });
    await purgeLegacyPersistedUrlCache();
  },
}));
