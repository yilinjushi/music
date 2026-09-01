import { isIP } from "node:net";
import { serve } from "@hono/node-server";
import { app } from "../functions/app";
import { parseConfiguredAppOrigin } from "../functions/utils/app-origin";
import type { Env } from "../functions/types/hono";
import { createNodeExecutionContext, WaitUntilTracker } from "./execution-context";
import { MemoryResponseCache } from "./memory-cache";
import { createSqliteKvStores, type SqliteKV } from "./sqlite-kv";
import { VpsAudioCache } from "./audio-cache";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const WAIT_UNTIL_DRAIN_MS = 5_000;
const TRUSTED_CLIENT_IP_HEADER = "x-otter-client-ip";

function requiredSecret(name: string, minimumLength = 32): string {
  const value = process.env[name];
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} is missing or too short`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OTTER_MUSIC_PORT is invalid");
  }
  return port;
}

function buildRuntimeEnv(dataDir: string): {
  env: Env;
  stores: SqliteKV[];
  audioCache: VpsAudioCache;
} {
  const appOrigin = parseConfiguredAppOrigin(process.env.APP_ORIGIN);
  if (!appOrigin) throw new Error("APP_ORIGIN must be an exact HTTPS origin");
  const hmacSecret = requiredSecret("NETEASE_SESSION_HMAC_SECRET");
  const encryptionSecret = requiredSecret("NETEASE_CREDENTIAL_ENC_KEY");
  if (hmacSecret === encryptionSecret) {
    throw new Error("NetEase session secrets must be independent");
  }

  const storePair = createSqliteKvStores(dataDir);
  const stores = [storePair.rateLimit, storePair.session];
  const audioCache = new VpsAudioCache(dataDir);
  const responseCache = new MemoryResponseCache();
  return {
    env: {
      APP_ORIGIN: appOrigin,
      NETEASE_SESSION_HMAC_SECRET: hmacSecret,
      NETEASE_CREDENTIAL_ENC_KEY: encryptionSecret,
      NETEASE_SESSION_TTL_SECONDS:
        process.env.NETEASE_SESSION_TTL_SECONDS || "2592000",
      oh_file_url: storePair.rateLimit,
      SESSION_KV: storePair.session,
      CACHE: responseCache,
      AUDIO_CACHE: audioCache,
    },
    stores,
    audioCache,
  };
}

function publicRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  const trustedIp = headers.get(TRUSTED_CLIENT_IP_HEADER)?.trim() || "";
  headers.delete(TRUSTED_CLIENT_IP_HEADER);
  headers.delete("cf-connecting-ip");
  if (isIP(trustedIp) !== 0) headers.set("cf-connecting-ip", trustedIp);

  const forwardedProto = headers.get("x-forwarded-proto")?.trim();
  const forwardedScheme =
    forwardedProto === "http" || forwardedProto === "http:"
      ? "http:"
      : forwardedProto === "https" || forwardedProto === "https:"
        ? "https:"
        : undefined;
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || headers.get("host")?.trim();
  let url = request.url;
  if (
    host &&
    !/[\s\\/]/.test(host) &&
    forwardedScheme
  ) {
    const current = new URL(request.url);
    url = `${forwardedScheme}//${host}${current.pathname}${current.search}`;
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: request.redirect,
    integrity: request.integrity,
    keepalive: request.keepalive,
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(url, init);
}

function closeStores(stores: SqliteKV[]): void {
  for (const store of stores) store.close();
}

function start(): void {
  const dataDir = process.env.OTTER_MUSIC_DATA_DIR || "/var/lib/otter-music";
  const { env, stores, audioCache } = buildRuntimeEnv(dataDir);
  const tracker = new WaitUntilTracker();
  let shuttingDown = false;
  const server = serve(
    {
      fetch: (request) =>
        app.fetch(
          publicRequest(request),
          env,
          createNodeExecutionContext(tracker) as unknown as Parameters<
            typeof app.fetch
          >[2]
        ),
      hostname: process.env.OTTER_MUSIC_HOST || DEFAULT_HOST,
      port: parsePort(process.env.OTTER_MUSIC_PORT),
    },
    () => undefined
  );

  const shutdown = (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceExit = setTimeout(() => {
      audioCache.close();
      closeStores(stores);
      process.exit(exitCode);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    const finish = () => {
      void tracker.drain(WAIT_UNTIL_DRAIN_MS).finally(() => {
        clearTimeout(forceExit);
        audioCache.close();
        closeStores(stores);
        process.exit(exitCode);
      });
    };
    server.close(finish);
  };

  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));

}

try {
  start();
} catch (error) {
  process.stderr.write(
    `otter-music server startup failed: ${
      error instanceof Error ? error.message : "unknown error"
    }\n`
  );
  process.exitCode = 1;
}
