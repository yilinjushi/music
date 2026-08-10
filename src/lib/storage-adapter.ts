import type { StateStorage } from "zustand/middleware";
import { del, get, set } from "idb-keyval";

interface PersistEnvelope {
  state?: unknown;
  version?: unknown;
}

interface SanitizingStorageOptions<T> {
  version: number;
  sanitize: (value: unknown) => T;
}

function readPersistEnvelope(value: string): PersistEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as PersistEnvelope;
  } catch {
    return null;
  }
}

/**
 * Sanitize both hydration reads and persistence writes at the serialized
 * boundary. This rewrites contaminated current-version envelopes as well as
 * legacy versions; Zustand's `migrate` callback alone only runs after a
 * version change.
 */
export function createSanitizingStateStorage<T>(
  baseStorage: StateStorage,
  { version, sanitize }: SanitizingStorageOptions<T>
): StateStorage {
  const sanitizeEnvelope = (raw: string): string | null => {
    const envelope = readPersistEnvelope(raw);
    if (!envelope) return null;
    return JSON.stringify({ state: sanitize(envelope.state), version });
  };

  return {
    getItem: async (name) => {
      const raw = await baseStorage.getItem(name);
      if (raw === null) return null;

      const clean = sanitizeEnvelope(raw);
      if (clean === null) {
        await baseStorage.removeItem(name);
        return null;
      }
      if (clean !== raw) await baseStorage.setItem(name, clean);
      return clean;
    },
    setItem: async (name, value) => {
      const clean = sanitizeEnvelope(value);
      if (clean === null) {
        await baseStorage.removeItem(name);
        return;
      }
      await baseStorage.setItem(name, clean);
    },
    removeItem: (name) => baseStorage.removeItem(name),
  };
}

/**
 * 基于 idb-keyval 的异步存储适配器
 * 用于替代 localStorage，解决容量限制和主线程阻塞问题
 *
 * 包含自动迁移逻辑：
 * 如果 IndexedDB 中没有数据，尝试从 localStorage 读取并迁移
 */
export const idbStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    // 1. 尝试从 IndexedDB 读取
    const value: unknown = await get(name);
    if (typeof value === "string") {
      return value;
    }
    if (value !== undefined && value !== null) {
      await del(name);
    }

    // 2. 如果 IndexedDB 为空，尝试从 localStorage 读取（迁移逻辑）
    const localValue = localStorage.getItem(name);
    if (localValue) {
      // Never copy an untrusted legacy blob into IndexedDB before the owning
      // store has run its schema migration/allowlist. A later sanitized
      // `setItem` establishes the IDB copy before removing this value.
      return localValue;
    }

    return null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await set(name, value);
    localStorage.removeItem(name);
  },
  removeItem: async (name: string): Promise<void> => {
    await del(name);
    // 同时也清理 localStorage，确保彻底删除
    localStorage.removeItem(name);
  },
};
