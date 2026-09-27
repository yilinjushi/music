export interface KVNamespace {
  get(key: string, options?: any): Promise<any>;
  put(key: string, value: any, options?: any): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: any): Promise<any>;
  getWithMetadata<T = unknown>(
    key: string,
    options?: { type?: "text" | "json" | "arrayBuffer" | "stream" }
  ): Promise<{ value: any; metadata: T | null }>;
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

export type AudioCacheJobState = "queued" | "running" | "completed" | "failed";

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

export interface AudioCacheNeteaseTrack {
  id: string;
  urlId?: string;
  name: string;
  artist: string[];
  duration?: number;
}

export type AudioCacheTrackState = "cached" | "pending" | "queued";

export interface AudioCacheSyncResult {
  total: number;
  ready: number;
  pending: number;
  submitted: number;
  unavailable: string[];
  remaining: number;
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
  cacheNeteaseTrack(
    track: AudioCacheNeteaseTrack,
    credential: string
  ): Promise<AudioCacheTrackState>;
  syncNeteasePlaylist(
    playlistId: string,
    credential: string,
    budget?: { timeMs?: number; subrequests?: number }
  ): Promise<AudioCacheSyncResult>;
  getPlaylistStatus(
    playlistId: string
  ): Promise<(AudioCacheSyncResult & { updatedAt: number }) | null>;
  getJob(jobId: string): Promise<AudioCacheJobStatus | null>;
}

export type Env = {
  APP_ORIGIN: string;
  oh_file_url: KVNamespace;
  SESSION_KV: KVNamespace;
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
  CRON_SECRET?: string;
};
