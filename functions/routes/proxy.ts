import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { proxyGet, filterResponseHeaders } from "@utils/proxy";
import { normalizeProxyTarget } from "@utils/proxy/fetch";
import type { Env } from "../types/hono";
import { fail } from "@utils/response";
import {
  checkFixedWindowRateLimit,
  requestClientId,
} from "@utils/request-rate-limit";
import { containsSensitiveData, containsSensitiveString } from "@utils/cache";
import {
  FUNCTION_LOG_EVENTS,
  logFunctionError,
  logFunctionWarning,
} from "@utils/security-logger";
import {
  parseConfiguredAppOrigin,
  parseRequestOrigin,
} from "@utils/app-origin";

export const proxyRoutes = new Hono<{ Bindings: Env }>();

const PROXY_RECURSION_HEADER = "X-Otter-Proxy-Request";

const proxySchema = z
  .object({
    url: z.string().url().max(4096),
    headers: z.string().max(2048).optional(),
    filename: z.string().max(180).optional(),
  })
  .strict();

type ProxyQuery = z.infer<typeof proxySchema>;

class ProxyPolicyError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 = 400
  ) {
    super("Proxy policy rejection");
  }
}

export function isAllowedProxyRequestOrigin(
  requestUrl: string,
  requestOrigin: string | undefined,
  configuredOrigin?: string
): boolean {
  const configured = parseConfiguredAppOrigin(configuredOrigin);
  if (!configured) return false;
  if (!requestOrigin) return true;
  const origin = parseRequestOrigin(requestOrigin);
  if (!origin) return false;
  if (origin === new URL(requestUrl).origin) return true;
  return origin === configured;
}

// --- 辅助函数 ---

// 1. 错误处理
const handleError = (c: Context, error: unknown) => {
  const isPolicyError = error instanceof ProxyPolicyError;
  if (isPolicyError) {
    logFunctionWarning(FUNCTION_LOG_EVENTS.PROXY_POLICY_REJECTED);
  } else {
    logFunctionError(FUNCTION_LOG_EVENTS.PROXY_UPSTREAM_FAILED);
  }
  c.header("Cache-Control", "private, no-store, max-age=0");
  return fail(
    c,
    isPolicyError ? "Proxy request is not allowed" : "Proxy upstream failed",
    isPolicyError ? error.status : 502
  );
};

// 2. 统一处理响应头
const applyCommonHeaders = (
  c: Context,
  headers: Headers,
  filename?: string
) => {
  if (filename) {
    const encoded = encodeURIComponent(filename);
    headers.set(
      "Content-Disposition",
      `attachment; filename="${filename.replace(/"/g, "")}"; filename*=UTF-8''${encoded}`
    );
  }

  return headers;
};

// 3. 解析与校验参数
const parseProxyParams = (c: Context, query: ProxyQuery) => {
  const { url: rawTargetUrl, headers: headersParam, filename } = query;
  if (filename && containsSensitiveString(filename)) {
    throw new ProxyPolicyError("sensitive-filename");
  }
  let targetCandidate = rawTargetUrl;
  if (!/^https?:\/\//i.test(targetCandidate)) {
    try {
      targetCandidate = decodeURIComponent(targetCandidate);
    } catch {
      throw new ProxyPolicyError("invalid-target");
    }
  }
  const parsedTarget = normalizeProxyTarget(targetCandidate);
  if (!parsedTarget) throw new ProxyPolicyError("invalid-target");
  const targetUrl = parsedTarget.toString();
  if (containsSensitiveString(targetUrl)) {
    throw new ProxyPolicyError("sensitive-query");
  }
  const targetHost = parsedTarget.host;

  // 严苛的递归拦截
  if (
    c.req.header(PROXY_RECURSION_HEADER) ||
    c.req.header("host") === targetHost
  ) {
    throw new ProxyPolicyError("recursive-request");
  }

  const customHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    [PROXY_RECURSION_HEADER]: "1", // 标记代理请求
  };

  // 过滤敏感 Header 注入
  if (headersParam) {
    try {
      const parsed = JSON.parse(headersParam);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        containsSensitiveData(parsed)
      ) {
        throw new ProxyPolicyError("sensitive-headers");
      }
      const allowedKeys = new Set(["accept", "referer", "user-agent"]);
      for (const [k, v] of Object.entries(parsed)) {
        const key = k.toLowerCase();
        const value = String(v);
        if (
          allowedKeys.has(key) &&
          value.length <= 512 &&
          !/[\r\n]/.test(value)
        ) {
          customHeaders[key] = value;
        }
      }
    } catch (error) {
      if (error instanceof ProxyPolicyError) throw error;
      throw new ProxyPolicyError("invalid-headers");
    }
  }

  const range = c.req.header("range");
  if (range) {
    if (containsSensitiveString(range)) {
      throw new ProxyPolicyError("sensitive-range");
    }
    customHeaders["range"] = range;
  }
  const ifRange = c.req.header("if-range");
  if (ifRange) {
    if (containsSensitiveString(ifRange)) {
      throw new ProxyPolicyError("sensitive-if-range");
    }
    customHeaders["if-range"] = ifRange;
  }

  return {
    targetUrl,
    targetHasQuery: parsedTarget.search.length > 0,
    customHeaders,
    filename,
  };
};

// --- 路由处理 ---

const validator = zValidator("query", proxySchema, (result, c) => {
  if (!result.success) {
    c.header("Cache-Control", "private, no-store, max-age=0");
    return fail(c, "Invalid proxy request", 400);
  }
});

proxyRoutes.get("/", validator, async (c) => {
  try {
    const isOriginViolation =
      c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site" ||
      !isAllowedProxyRequestOrigin(
        c.req.url,
        c.req.header("Origin"),
        c.env.APP_ORIGIN
      );
    if (isOriginViolation) {
      throw new ProxyPolicyError("origin", 403);
    }

    // Parse and reject credentials/capabilities before any upstream work.
    const { targetUrl, targetHasQuery, customHeaders, filename } =
      parseProxyParams(c, c.req.valid("query"));

    const rate = await checkFixedWindowRateLimit(
      c.env.oh_file_url,
      "media-proxy",
      requestClientId(c.req.raw.headers),
      120,
      60
    );
    c.header("X-RateLimit-Remaining", String(rate.remaining));
    if (!rate.allowed) {
      c.header("Retry-After", String(rate.retryAfterSeconds));
      return fail(c, "Too many media proxy requests", 429);
    }

    const response = await proxyGet(targetUrl, customHeaders);

    // 过滤源站响应头，保留安全头（Accept-Ranges、Cache-Control、Content-Length 等）
    const filteredHeaders = filterResponseHeaders(
      new Headers(response.headers)
    );
    const finalHeaders = applyCommonHeaders(c, filteredHeaders, filename);
    // Unknown query names can still be playback capabilities. They may be
    // fetched for same-origin playback, but can never become public cache
    // entries merely because the denylist does not recognize their name.
    const mustRemainPrivate =
      targetHasQuery ||
      Boolean(c.req.header("Range")) ||
      response.status !== 200;
    finalHeaders.set(
      "Cache-Control",
      mustRemainPrivate
        ? "private, no-store"
        : "public, max-age=3600, stale-while-revalidate=300"
    );
    finalHeaders.set("X-Content-Type-Options", "nosniff");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: finalHeaders,
    });
  } catch (error: unknown) {
    return handleError(c, error);
  }
});
