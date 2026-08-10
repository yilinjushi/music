export const createNeteaseMarketCacheKey = (category: string, offset: number) =>
  `netease:market-playlist:v3:${category || "all"}:${offset}`;
