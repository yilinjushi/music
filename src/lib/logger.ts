import { formatDate } from "date-fns";
import {
  isSensitiveAssignmentName,
  stringContainsSensitiveAssignment,
} from "@/lib/utils/sensitive-data";
import { sensitiveDecodeVariants } from "@shared/utils/sensitive-fields";

const LOG_STORAGE_KEY = "otter-debug-logs";
const MAX_LOG_ENTRIES = 100;
const APP_START_TIME = formatDate(new Date(), "yyyy-MM-dd HH:mm:ss");
const IS_BROWSER = typeof window !== "undefined";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  id: string;
  time: string;
  level: LogLevel;
  source: string;
  message: string;
  stack?: string;
  context?: unknown;
}

const REDACTED = "[REDACTED]";
// Authorization values are credentials as a whole. In particular, Digest and
// AWS4 credentials contain comma-separated sub-fields, so redacting only the
// first assignment would leave the rest of the credential in logs.
const AUTH_CREDENTIAL_PATTERN =
  /\b(Bearer|Basic|Digest|Negotiate|NTLM|Api[-_ ]?Key|Token|OAuth|MAC|HMAC|Signature|SCRAM-SHA-256|AWS4-HMAC-SHA256)\s+[^\r\n]+/gi;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /(^|[?&#;,/=\s{[(])(["']?)([a-z_][a-z0-9_.-]{0,48})\2(\s*(?:=|:)\s*)/gi;
const SPACED_PROXY_AUTH_PATTERN =
  /((?:^|[^a-z0-9_])["']?proxy\s+(?:authorization|auth)["']?\s*(?:=|:)\s*)[^\r\n]*/gi;
const LINE_VALUE_SENSITIVE_FIELDS = new Set([
  "authorization",
  "proxyauth",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "xapikey",
  "authtoken",
  "xauthtoken",
  "xrequestkey",
  "xrealcookie",
  "xforwardedcookie",
]);

function stripUrlDetails(candidate: string): string {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return candidate;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return candidate.split(/[?#]/, 1)[0];
  }
}

function decodePercentEncodedRuns(value: string): string {
  const variants = sensitiveDecodeVariants(value);
  return variants[variants.length - 1] ?? value;
}

function findAssignmentValueEnd(value: string, start: number): number {
  const quote = value[start];
  if (quote === '"' || quote === "'") {
    const closingQuote = value.indexOf(quote, start + 1);
    return closingQuote === -1 ? value.length : closingQuote + 1;
  }

  let end = start;
  while (end < value.length && !/[\s;,&)}\]]/.test(value[end])) end += 1;
  return end;
}

function findLineEnd(value: string, start: number): number {
  const lineFeed = value.indexOf("\n", start);
  const carriageReturn = value.indexOf("\r", start);
  if (lineFeed === -1)
    return carriageReturn === -1 ? value.length : carriageReturn;
  if (carriageReturn === -1) return lineFeed;
  return Math.min(lineFeed, carriageReturn);
}

function redactSensitiveAssignments(value: string): string {
  SENSITIVE_ASSIGNMENT_PATTERN.lastIndex = 0;
  let cursor = 0;
  let sanitized = "";
  let match: RegExpExecArray | null;

  while ((match = SENSITIVE_ASSIGNMENT_PATTERN.exec(value)) !== null) {
    if (!isSensitiveAssignmentName(match[3])) {
      // A non-sensitive label may consume the whitespace prefix of a nested
      // sensitive header (`Error: Proxy-Authorization: ...`). Resume inside
      // the match so that nested labels cannot be skipped.
      SENSITIVE_ASSIGNMENT_PATTERN.lastIndex = match.index + 1;
      continue;
    }
    // A colon-shaped sensitive assignment is a header/log label. Its value
    // can use a custom authentication scheme and contain arbitrary spaces,
    // commas and punctuation, so redact to the end of that line.
    const compactName = match[3].toLowerCase().replace(/[^a-z0-9]/g, "");
    const valueEnd =
      match[4].includes(":") || LINE_VALUE_SENSITIVE_FIELDS.has(compactName)
        ? findLineEnd(value, SENSITIVE_ASSIGNMENT_PATTERN.lastIndex)
        : findAssignmentValueEnd(value, SENSITIVE_ASSIGNMENT_PATTERN.lastIndex);
    sanitized += value.slice(cursor, match.index) + match[0] + REDACTED;
    cursor = valueEnd;
    SENSITIVE_ASSIGNMENT_PATTERN.lastIndex = valueEnd;
  }

  return sanitized + value.slice(cursor);
}

function redactSensitiveText(value: string): string {
  const withoutCredentials = value
    .replace(
      AUTH_CREDENTIAL_PATTERN,
      (_match, scheme: string) => `${scheme} ${REDACTED}`
    )
    .replace(
      SPACED_PROXY_AUTH_PATTERN,
      (_match, label: string) => `${label}${REDACTED}`
    );
  return redactSensitiveAssignments(withoutCredentials);
}

/** Remove query strings and fragments from URLs embedded in log text. */
export function sanitizeLogText(value: string): string {
  const withoutUrlDetails = decodePercentEncodedRuns(value)
    .replace(/https?:\/\/[^\s)\]>"']+/gi, (url) => stripUrlDetails(url))
    .replace(
      /(^|[\s:(])((?:\/)[^\s)\]>"']*[?#][^\s)\]>"']*)/g,
      (_match, prefix: string, url: string) =>
        `${prefix}${url.split(/[?#]/, 1)[0]}`
    );
  return redactSensitiveText(withoutUrlDetails);
}

/** Recursively sanitize structured metadata before it reaches persistence. */
export function sanitizeLogValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): unknown {
  if (typeof value === "string") return sanitizeLogText(value);
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (depth >= 8) return "[Max depth]";
  if (value instanceof URL) {
    return sanitizeLogText(`${value.origin}${value.pathname}`);
  }
  if (value instanceof Error) {
    return {
      name: sanitizeLogText(value.name),
      message: sanitizeLogText(value.message),
      stack: value.stack ? sanitizeLogText(value.stack) : undefined,
    };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => sanitizeLogValue(item, seen, depth + 1));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return "[Unsupported object]";
  }

  const sanitized: Record<string, unknown> = {};
  for (const rawKey of Reflect.ownKeys(value)) {
    if (typeof rawKey !== "string") {
      sanitized["[REDACTED_FIELD]"] = REDACTED;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, rawKey);
    if (!descriptor || !("value" in descriptor)) {
      sanitized[sanitizeLogText(rawKey)] = REDACTED;
      continue;
    }

    const key = stringContainsSensitiveAssignment(rawKey)
      ? "[REDACTED_FIELD]"
      : sanitizeLogText(rawKey);
    sanitized[key] = isSensitiveAssignmentName(rawKey)
      ? REDACTED
      : sanitizeLogValue(descriptor.value, seen, depth + 1);
  }
  return sanitized;
}

function sanitizeLogEntry(value: unknown): LogEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<LogEntry>;
  const level: LogLevel = ["info", "warn", "error"].includes(
    String(candidate.level)
  )
    ? (candidate.level as LogLevel)
    : "error";
  return {
    id: sanitizeLogText(String(candidate.id || "legacy")),
    time: sanitizeLogText(String(candidate.time || APP_START_TIME)),
    level,
    source: sanitizeLogText(String(candidate.source || "legacy")),
    message: sanitizeLogText(String(candidate.message || "Legacy log entry")),
    stack:
      typeof candidate.stack === "string"
        ? sanitizeLogText(candidate.stack)
        : undefined,
    context: sanitizeLogValue(candidate.context),
  };
}

function sanitizeLogEntries(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(sanitizeLogEntry)
    .filter((entry): entry is LogEntry => entry !== null)
    .slice(-MAX_LOG_ENTRIES);
}

// 1. 内存缓存：避免每次写入都触发高昂的 localStorage 读取开销
let logsCache: LogEntry[] = [];
if (IS_BROWSER) {
  try {
    const raw = window.localStorage.getItem(LOG_STORAGE_KEY);
    logsCache = raw ? sanitizeLogEntries(JSON.parse(raw)) : [];
    // Migrate legacy entries immediately so a later crash/export cannot read
    // the unsanitized copy that predated the current logger.
    window.localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logsCache));
  } catch {
    logsCache = [];
    try {
      window.localStorage.setItem(LOG_STORAGE_KEY, "[]");
    } catch {
      // Storage may be unavailable in private browsing.
    }
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

const writeToStorage = () => {
  if (!IS_BROWSER) return;
  try {
    logsCache = sanitizeLogEntries(logsCache);
    window.localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logsCache));
  } catch {
    console.error("Logger persistence failed");
  }
};

const schedulePersist = () => {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeToStorage();
  }, 2000);
};

const flushPersist = () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  writeToStorage();
};

// 页面卸载时确保写入
if (IS_BROWSER) {
  window.addEventListener("beforeunload", flushPersist);
}

// 2. 优化调用栈解析逻辑
const getSource = () => {
  try {
    throw new Error();
  } catch (caught: unknown) {
    const stack = caught instanceof Error ? caught.stack : undefined;
    const match = stack?.split("\n")[4]?.match(/\((.*):\d+:\d+\)/);
    return match?.[1]?.split("/").pop() || "unknown";
  }
};

const createAndSaveLog = (level: LogLevel, args: unknown[]): LogEntry => {
  let source: string;
  let message: string;
  let error: Error | undefined;
  let context: unknown;
  let possibleError: unknown;

  // 灵活的参数重载解析
  if (
    args.length >= 2 &&
    typeof args[0] === "string" &&
    typeof args[1] === "string"
  ) {
    source = args[0];
    message = args[1];
    possibleError = args[2];
    context = args[3];
  } else {
    source = getSource();
    message = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    possibleError = args[1];
    context = args[2];
  }

  if (possibleError instanceof Error) {
    error = possibleError;
  } else if (possibleError !== undefined) {
    context = possibleError;
  }

  const entry: LogEntry = {
    id: crypto.randomUUID?.() || Math.random().toString(36).slice(2),
    time: formatDate(new Date(), "yyyy-MM-dd HH:mm:ss"),
    level,
    source: sanitizeLogText(source),
    message: sanitizeLogText(message || error?.message || String(message)),
    stack: error?.stack ? sanitizeLogText(error.stack) : undefined,
    context: sanitizeLogValue(context ?? undefined),
  };

  // 维护内存队列并同步
  // INFO: 仅 console（不持久化）
  // WARN: debounce 写入（2s 合并）
  // ERROR: 立即写入
  logsCache.push(entry);
  if (logsCache.length > MAX_LOG_ENTRIES) logsCache.shift();
  if (level === "error") flushPersist();
  else if (level === "warn") schedulePersist();

  if (import.meta.env?.DEV) {
    console[level](
      `[${entry.source}] ${entry.message}`,
      entry.context ?? entry.stack ?? ""
    );
  }
  return entry;
};

export const logger = {
  info: (...args: unknown[]) => createAndSaveLog("info", args),
  warn: (...args: unknown[]) => createAndSaveLog("warn", args),
  error: (...args: unknown[]) => createAndSaveLog("error", args),
  getLogs: () => sanitizeLogEntries(logsCache),
  getRecentLogs: () =>
    sanitizeLogEntries(logsCache).filter(
      (entry) => entry.time >= APP_START_TIME
    ),
  getLastNLogs: (n: number) => sanitizeLogEntries(logsCache).slice(-n),
  clear: () => {
    logsCache = [];
    flushPersist();
  },
  exportText: (filter?: { recent?: boolean; lastN?: number }) => {
    logsCache = sanitizeLogEntries(logsCache);
    let res = logsCache.filter((entry) => entry.level !== "info");
    if (filter?.recent) {
      res = res.filter((entry) => entry.time >= APP_START_TIME);
    }
    if (filter?.lastN) res = res.slice(-filter.lastN);

    return sanitizeLogText(
      res
        .map((entry) => {
          const context = entry.context
            ? `\ncontext: ${JSON.stringify(sanitizeLogValue(entry.context), null, 2)}`
            : "";
          const stack = entry.stack ? `\n${sanitizeLogText(entry.stack)}` : "";
          return `[${entry.time}] ${entry.level.toUpperCase()} ${entry.source}: ${entry.message}${stack}${context}`;
        })
        .join("\n\n")
    );
  },
};

export function captureWindowErrors() {
  if (!IS_BROWSER) return () => {};

  const onError = (e: ErrorEvent) =>
    logger.error("window.error", e.message || "Unhandled error", e.error, {
      file: e.filename,
      line: e.lineno,
    });
  const onReject = (e: PromiseRejectionEvent) =>
    logger.error(
      "window.unhandledrejection",
      e.reason instanceof Error ? e.reason.message : String(e.reason),
      e.reason
    );

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onReject);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onReject);
  };
}

function interceptNetworkRequests() {
  if (!IS_BROWSER) return () => {};

  const { fetch: origFetch, XMLHttpRequest: OrigXHR } = window;

  window.fetch = async (...args) => {
    const start = Date.now();
    try {
      const res = await origFetch(...args);
      if (!res.ok)
        logger.warn("Network", `Fetch failed: ${res.url}`, {
          status: res.status,
          duration: Date.now() - start,
        });
      return res;
    } catch (err) {
      logger.error("Network", "Fetch error", err);
      throw err;
    }
  };

  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    let reqMethod = "",
      reqUrl = "";
    const start = Date.now();

    xhr.addEventListener("load", () => {
      if (xhr.status >= 400)
        logger.warn("Network", `XHR failed: ${reqMethod} ${reqUrl}`, {
          status: xhr.status,
          duration: Date.now() - start,
        });
    });
    xhr.addEventListener("error", () =>
      logger.error("Network", `XHR error: ${reqMethod} ${reqUrl}`)
    );

    const origOpen = xhr.open;
    xhr.open = function (method: string, url: string | URL, ...rest: any[]) {
      reqMethod = method; // 修复了原版中 method = method 作用域覆盖导致的 Bug
      reqUrl = url.toString();
      return origOpen.apply(this, [method, url, ...rest] as any);
    };
    return xhr;
  } as any;

  return () => {
    window.fetch = origFetch;
    window.XMLHttpRequest = OrigXHR;
  };
}

export function initializeLogger() {
  captureWindowErrors();
  interceptNetworkRequests();
  const platform = IS_BROWSER ? "web" : "server";
  const env = import.meta.env?.DEV ? "development" : "production";
  logger.info("system", `App started at ${APP_START_TIME}`, {
    version: __APP_VERSION__,
    platform,
    env,
  });
}
