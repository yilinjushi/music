import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KVNamespace } from "../functions/types/hono";

type KvReadOptions =
  | "text"
  | "json"
  | "arrayBuffer"
  | "stream"
  | { type?: "text" | "json" | "arrayBuffer" | "stream" };

type KvWriteOptions = {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
};

type KvListOptions = {
  prefix?: string;
  limit?: number;
  cursor?: string;
};

type SqlValue = string | number | bigint | Uint8Array | null;

interface StoredRow {
  key: SqlValue;
  value: SqlValue;
  expires_at: SqlValue;
  metadata: SqlValue;
}

interface ListRow {
  key: SqlValue;
  expires_at: SqlValue;
  metadata: SqlValue;
}

const SCHEMA_VERSION = 1;
const MAX_LIST_LIMIT = 1_000;

function asString(value: SqlValue, field: string): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  throw new Error(`Invalid SQLite ${field}`);
}

function asNullableNumber(value: SqlValue): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error("Invalid SQLite expiration");
}

function readType(
  options: KvReadOptions | undefined
): "text" | "json" | "arrayBuffer" | "stream" {
  if (typeof options === "string") return options;
  return options?.type ?? "text";
}

function serializeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (value instanceof ArrayBuffer)
    return Buffer.from(value).toString("utf8");
  throw new TypeError("SQLite KV values must be strings or byte arrays");
}

function serializeMetadata(value: unknown): string | null {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Invalid KV metadata");
  return serialized;
}

function decodeValue<T>(value: string, options: KvReadOptions | undefined): T {
  const type = readType(options);
  if (type === "json") return JSON.parse(value) as T;
  if (type === "arrayBuffer")
    return Uint8Array.from(Buffer.from(value, "utf8")).buffer as T;
  if (type === "stream") {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from(Buffer.from(value, "utf8")));
        controller.close();
      },
    }) as T;
  }
  return value as T;
}

function decodeMetadata(value: SqlValue): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(asString(value, "metadata"));
  } catch {
    return null;
  }
}

function normalizeExpiration(
  options: KvWriteOptions | undefined,
  nowSeconds: number
): number | null {
  if (options?.expiration !== undefined) {
    if (!Number.isFinite(options.expiration) || options.expiration <= 0) {
      throw new TypeError("Invalid KV expiration");
    }
    return Math.floor(options.expiration);
  }
  if (options?.expirationTtl !== undefined) {
    if (
      !Number.isFinite(options.expirationTtl) ||
      options.expirationTtl <= 0
    ) {
      throw new TypeError("Invalid KV expiration TTL");
    }
    return nowSeconds + Math.floor(options.expirationTtl);
  }
  return null;
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(value)));
}

/**
 * Small persistent implementation of the subset of Workers KV used by the
 * application. Each instance represents one logical namespace. All SQLite
 * calls are synchronous by design, so a single Node process cannot interleave
 * a transaction between the read and write statements.
 */
export class SqliteKV implements KVNamespace {
  readonly database: DatabaseSync;
  readonly namespace: string;

  constructor(filePath: string, namespace: string) {
    this.namespace = namespace;
    if (filePath !== ":memory:") {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      chmodSync(dirname(filePath), 0o700);
    }

    this.database = new DatabaseSync(filePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS kv (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER,
        metadata TEXT,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS kv_expiration_idx
        ON kv (namespace, expires_at);
    `);

    const version = this.database
      .prepare("PRAGMA user_version")
      .get() as { user_version?: number };
    const currentVersion = Number(version.user_version ?? 0);
    if (currentVersion === 0) {
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (currentVersion !== SCHEMA_VERSION) {
      throw new Error("Unsupported SQLite KV schema version");
    }

    if (filePath !== ":memory:") chmodSync(filePath, 0o600);
  }

  private nowSeconds(nowMs = Date.now()): number {
    return Math.floor(nowMs / 1000);
  }

  private readRow(key: string): StoredRow | null {
    const row = this.database
      .prepare(
        "SELECT key, value, expires_at, metadata FROM kv WHERE namespace = ? AND key = ?"
      )
      .get(this.namespace, key) as unknown as StoredRow | undefined;
    if (!row) return null;

    const expiresAt = asNullableNumber(row.expires_at);
    if (expiresAt !== null && expiresAt <= this.nowSeconds()) {
      this.database
        .prepare("DELETE FROM kv WHERE namespace = ? AND key = ?")
        .run(this.namespace, key);
      return null;
    }
    return row;
  }

  async get<T = unknown>(
    key: string,
    options?: KvReadOptions
  ): Promise<T | null> {
    const row = this.readRow(key);
    if (!row) return null;
    return decodeValue<T>(asString(row.value, "value"), options);
  }

  async put(
    key: string,
    value: unknown,
    options?: KvWriteOptions
  ): Promise<void> {
    const nowSeconds = this.nowSeconds();
    const expiresAt = normalizeExpiration(options, nowSeconds);
    if (expiresAt !== null && expiresAt <= nowSeconds) {
      await this.delete(key);
      return;
    }

    this.database
      .prepare(
        `INSERT INTO kv (namespace, key, value, expires_at, metadata)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at,
           metadata = excluded.metadata`
      )
      .run(
        this.namespace,
        key,
        serializeValue(value),
        expiresAt,
        serializeMetadata(options?.metadata)
      );
  }

  async delete(key: string): Promise<void> {
    this.database
      .prepare("DELETE FROM kv WHERE namespace = ? AND key = ?")
      .run(this.namespace, key);
  }

  async getWithMetadata<T = unknown>(
    key: string,
    options?: KvReadOptions
  ): Promise<{ value: T | null; metadata: T | null }> {
    const row = this.readRow(key);
    if (!row) return { value: null, metadata: null };
    return {
      value: decodeValue<T>(asString(row.value, "value"), options),
      metadata: decodeMetadata(row.metadata) as T | null,
    };
  }

  async list(options?: KvListOptions): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    list_complete: boolean;
    cursor: string;
  }> {
    const prefix = options?.prefix ?? "";
    const cursor = options?.cursor ?? "";
    const limit = normalizeLimit(options?.limit);
    const rows = this.database
      .prepare(
        "SELECT key, expires_at, metadata FROM kv WHERE namespace = ? ORDER BY key ASC"
      )
      .all(this.namespace) as unknown as ListRow[];
    const nowSeconds = this.nowSeconds();
    const active = rows.filter((row) => {
      const key = asString(row.key, "key");
      const expiresAt = asNullableNumber(row.expires_at);
      if (expiresAt !== null && expiresAt <= nowSeconds) {
        this.database
          .prepare("DELETE FROM kv WHERE namespace = ? AND key = ?")
          .run(this.namespace, key);
        return false;
      }
      return key.startsWith(prefix) && key > cursor;
    });
    const selected = active.slice(0, limit);
    const keys = selected.map((row) => {
      const name = asString(row.key, "key");
      const expiration = asNullableNumber(row.expires_at);
      const metadata = decodeMetadata(row.metadata);
      return {
        name,
        ...(expiration === null ? {} : { expiration }),
        ...(metadata === null ? {} : { metadata }),
      };
    });
    return {
      keys,
      list_complete: selected.length >= active.length,
      cursor: keys.at(-1)?.name ?? cursor,
    };
  }

  /** Atomically consume one fixed-window counter for the application limiter. */
  async consumeFixedWindow(
    key: string,
    limit: number,
    expirationTtl: number,
    nowMs = Date.now()
  ): Promise<{ allowed: boolean; count: number }> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError("Invalid rate-limit limit");
    }
    if (!Number.isFinite(expirationTtl) || expirationTtl <= 0) {
      throw new TypeError("Invalid rate-limit TTL");
    }

    const nowSeconds = this.nowSeconds(nowMs);
    const expiresAt = nowSeconds + Math.max(60, Math.floor(expirationTtl));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare(
          "SELECT value, expires_at FROM kv WHERE namespace = ? AND key = ?"
        )
        .get(this.namespace, key) as
        | { value?: SqlValue; expires_at?: SqlValue }
        | undefined;
      const existingExpiresAt = asNullableNumber(row?.expires_at ?? null);
      const expired = existingExpiresAt !== null && existingExpiresAt <= nowSeconds;
      const parsed = expired ? 0 : Number.parseInt(asString(row?.value ?? "0", "value"), 10);
      const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      if (count >= limit) {
        this.database.exec("COMMIT");
        return { allowed: false, count };
      }

      this.database
        .prepare(
          `INSERT INTO kv (namespace, key, value, expires_at, metadata)
           VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value = excluded.value,
             expires_at = excluded.expires_at,
             metadata = NULL`
        )
        .run(this.namespace, key, String(count + 1), expiresAt);
      this.database.exec("COMMIT");
      return { allowed: true, count: count + 1 };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  }

  quickCheck(): string[] {
    return this.database
      .prepare("PRAGMA quick_check")
      .all()
      .map((row) => String((row as { quick_check?: unknown }).quick_check ?? ""));
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

export function createSqliteKvStores(dataDir: string): {
  rateLimit: SqliteKV;
  session: SqliteKV;
} {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  return {
    rateLimit: new SqliteKV(`${dataDir}/rate-limit.sqlite`, "rate-limit"),
    session: new SqliteKV(`${dataDir}/session.sqlite`, "session"),
  };
}
