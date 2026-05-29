/**
 * Listing-description vocabulary loading + keyword extraction.
 *
 * The keyword extractor itself (`extractFeatures` / `ExtractedFeatures`)
 * is hoisted to `@chrischall/realty-core` — onehome-mcp was the canonical
 * donor for it (its tighter `BASEMENT_CONNECTOR` detector is the cohort
 * canonical form), so we re-export the package version verbatim rather
 * than keep a byte-for-byte inline copy. Motivation unchanged (issue #14:
 * a 53-listing session, ~100 KB of marketing copy the caller immediately
 * keyword-parsed and discarded).
 *
 * `loadCommunities` STAYS local: it does filesystem I/O (reads a JSON file
 * named by `ONEHOME_COMMUNITIES_FILE`), and realty-core is deliberately
 * dependency-free / no-I/O. The consumer resolves the vocabulary and
 * passes the resolved `string[]` into the pure `extractFeatures`.
 */

import { existsSync, readFileSync } from 'node:fs';

export { extractFeatures } from '@chrischall/realty-core';
export type { ExtractedFeatures } from '@chrischall/realty-core';

/**
 * Default community vocabulary for the Lake Lure / mountain-NC market.
 * Users in other markets can override via the `ONEHOME_COMMUNITIES_FILE`
 * env var (JSON file containing a string array) — see `loadCommunities`.
 */
export const DEFAULT_COMMUNITIES: string[] = [
  'Rumbling Bald',
  'Riverbend at Lake Lure',
  'The Lodges at Eagles Nest',
  'Hunters Ridge',
  'Beech Mountain Club',
  'The Cliffs',
  'Pinnacle Ridge',
  'Highland Heights',
  'Shelter Rock',
  'Charter Hills',
];

let cachedCommunities: string[] | null = null;
let cachedPath: string | null = null;

/**
 * Resolve the active community vocabulary. Reads `ONEHOME_COMMUNITIES_FILE`
 * (expects a JSON string array). Falls back to `DEFAULT_COMMUNITIES` when
 * unset, the file is missing, or the JSON is malformed (with a stderr
 * warning so misconfiguration is visible). Cached per process keyed by
 * the env-var value.
 */
export function loadCommunities(): string[] {
  const path = process.env.ONEHOME_COMMUNITIES_FILE?.trim();
  if (!path) {
    cachedCommunities = null;
    cachedPath = null;
    return DEFAULT_COMMUNITIES;
  }
  if (cachedCommunities && cachedPath === path) {
    return cachedCommunities;
  }
  if (!existsSync(path)) {
    console.error(
      `[onehome-mcp] ONEHOME_COMMUNITIES_FILE="${path}" not found — falling back to DEFAULT_COMMUNITIES.`
    );
    return DEFAULT_COMMUNITIES;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
      console.error(
        `[onehome-mcp] ONEHOME_COMMUNITIES_FILE="${path}" must be a JSON string array — falling back to DEFAULT_COMMUNITIES.`
      );
      return DEFAULT_COMMUNITIES;
    }
    cachedCommunities = parsed;
    cachedPath = path;
    return cachedCommunities;
  } catch (err) {
    console.error(
      `[onehome-mcp] failed to load ONEHOME_COMMUNITIES_FILE="${path}": ${
        err instanceof Error ? err.message : String(err)
      } — falling back to DEFAULT_COMMUNITIES.`
    );
    return DEFAULT_COMMUNITIES;
  }
}
