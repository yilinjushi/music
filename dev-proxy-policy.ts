export const BILIBILI_AUDIO_HOST_SUFFIXES = [
  "bilivideo.com",
  "hdslb.com",
] as const;

export const BILIBILI_IMAGE_HOST_SUFFIXES = [
  "hdslb.com",
  "biliimg.com",
] as const;

export function isHttpsUrlOnAllowedHost(
  value: string,
  allowedSuffixes: readonly string[]
): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      return false;
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return allowedSuffixes.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
    );
  } catch {
    return false;
  }
}
