export interface KVNamespace {
  get(key: string, options?: any): Promise<any>;
  put(key: string, value: any, options?: any): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: any): Promise<any>;
  getWithMetadata<T = unknown>(
    key: string,
    options?: { type?: "text" | "json" | "arrayBuffer" | "stream" }
  ): Promise<{ value: any; metadata: T | null }>;
  /**
   * Optional single-process implementation hook. Cloudflare KV does not
   * expose this method; the VPS SQLite adapter uses it for atomic counters.
   */
  consumeFixedWindow?: (
    key: string,
    limit: number,
    expirationTtl: number,
    nowMs?: number
  ) => Promise<{ allowed: boolean; count: number }>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

export interface ApiResponseCache {
  match(request: Request): Promise<Response | null>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

export interface AudioCacheTrackReference {
  source: string;
  id: string;
  urlId?: string;
}

export interface AudioCacheLookupResult {
  path: string;
  storedBr: number;
}

export type AudioCacheJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface AudioCacheJobStatus {
  jobId: string;
  state: AudioCacheJobState;
  total: number;
  processed: number;
  cached: number;
  skipped: number;
  failed: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface AudioCacheLike {
  lookup(
    track: AudioCacheTrackReference
  ): Promise<AudioCacheLookupResult | null>;
  serve(cacheKey: string, range?: string | null): Promise<Response | null>;
  startNeteasePlaylistJob(
    playlistId: string,
    credential: string
  ): Promise<AudioCacheJobStatus>;
  getJob(jobId: string): AudioCacheJobStatus | Promise<AudioCacheJobStatus | null> | null;
}

export type Env = {
  APP_ORIGIN: string;
  oh_file_url: KVNamespace;
  SESSION_KV: KVNamespace;
  CACHE?: ApiResponseCache;
  AUDIO_CACHE?: AudioCacheLike;
  NETEASE_SESSION_HMAC_SECRET: string;
  NETEASE_CREDENTIAL_ENC_KEY: string;
  NETEASE_SESSION_TTL_SECONDS?: string;
  QINIU_ACCESS_KEY?: string;
  QINIU_SECRET_KEY?: string;
  QINIU_AUDIO_CACHE_BUCKET?: string;
  QINIU_AUDIO_CACHE_REGION?: string;
  QINIU_AUDIO_CACHE_DOMAIN?: string;
  QINIU_AUDIO_CACHE_PREFIX?: string;
  PASSWORD?: string;
  GITHUB_TOKEN?: string;
};
