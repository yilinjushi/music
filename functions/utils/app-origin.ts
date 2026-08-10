/**
 * Parse the single browser origin trusted by the deployed Functions app.
 *
 * The value is deliberately stricter than a generic URL: production must
 * provide the exact HTTPS origin, without credentials, path, query, fragment,
 * trailing slash, or alternate spelling that URL canonicalisation would hide.
 */
export function parseConfiguredAppOrigin(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.origin !== value) return null;
    return value;
  } catch {
    return null;
  }
}

/** Browser Origin headers are serialized origins, never full URLs. */
export function parseRequestOrigin(value: string | undefined): string | null {
  if (!value || value === "null") return null;
  try {
    const parsed = new URL(value);
    return parsed.origin === value ? value : null;
  } catch {
    return null;
  }
}
