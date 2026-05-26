/**
 * URL + identifier helpers shared across tools.
 *
 * OneHome's portal links don't carry stable, human-meaningful paths
 * the way Compass and Redfin do. The browsable address is the
 * `listingId` (an OSK — Origin System Key) — a hash like
 * `EYxOzZS...XW32d8`. We accept either a raw listing id or the full
 * portal URL and reduce both to the id.
 */

/**
 * Extract a OneHome listing id from a URL, path, or raw id input.
 *
 * Recognized URL shapes (all link forms seen on portal.onehome.com
 * as of 2026-05-26):
 *
 *   https://portal.onehome.com/en-US/properties/<id>
 *   https://portal.onehome.com/en-US/property/<id>
 *   /en-US/properties/<id>
 *   <id>
 *
 * Returns the bare id (no slashes, no query) or null if nothing
 * looked like an id.
 */
export function extractListingId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Strip query + hash.
  const noQuery = trimmed.split(/[?#]/)[0]!;
  // Already an id-shaped token? OneHome OSKs are 20-60 chars of
  // letters / digits / a few symbols. We accept anything alphanumeric
  // and 8+ chars when it doesn't contain a slash.
  if (!noQuery.includes('/')) {
    return /^[A-Za-z0-9_~%.-]{6,}$/.test(noQuery) ? noQuery : null;
  }
  // URL or path. Take the last non-empty segment, but skip known
  // route prefixes ('properties', 'property') if they're the tail.
  const segments = noQuery.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1]!;
  if (last === 'properties' || last === 'property' || last === 'map') {
    return null;
  }
  return /^[A-Za-z0-9_~%.-]{6,}$/.test(last) ? last : null;
}
