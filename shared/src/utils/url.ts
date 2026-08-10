export const forceHttps = (url: string | undefined | null): string => {
  if (!url) return "";
  return url.replace(/^http:\/\//i, "https://");
};

export function normalizeResourceUrl(url: string): string {
  if (url.startsWith("//")) return `https:${url}`;
  return forceHttps(url);
}

export function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Normalize public artwork/lyric metadata before it crosses a persistence
 * boundary. Provider size parameters are optional presentation state, while
 * query strings, fragments and userinfo can also carry short-lived
 * capabilities and therefore must never become durable application data.
 */
export function normalizePersistableResourceUrl(
  value: string | undefined | null
): string {
  const candidate = value?.trim();
  if (
    !candidate ||
    candidate.length > 4096 ||
    containsControlCharacter(candidate)
  ) {
    return "";
  }

  try {
    const parsed = new URL(normalizeResourceUrl(candidate));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return "";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}
