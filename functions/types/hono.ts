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

export type Env = {
  APP_ORIGIN: string;
  oh_file_url: KVNamespace;
  SESSION_KV: KVNamespace;
  NETEASE_SESSION_HMAC_SECRET: string;
  NETEASE_CREDENTIAL_ENC_KEY: string;
  NETEASE_SESSION_TTL_SECONDS?: string;
  PASSWORD?: string;
  GITHUB_TOKEN?: string;
};
