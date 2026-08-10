/**
 * LX playback is intentionally unavailable until the application has a
 * dedicated same-origin BFF contract for it. Browser code must never embed or
 * forward a provider request key through the generic media proxy.
 */
export async function getLxUrl(
  _source: string,
  _songid: string,
  _br?: number
): Promise<string | null> {
  return null;
}
