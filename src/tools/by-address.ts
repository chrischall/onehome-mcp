import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { OneHomeClient } from '../client.js';
import { minifiedResult } from '../mcp.js';
import { viewArg, viewResponse } from '../view.js';
import {
  buildGetListings,
  buildGetSavedListings,
  buildGetSavedSearchBySearchId,
  buildListingSuggestionsSearch,
} from '../queries.js';
import { tokenize, addressMatch } from '@chrischall/realty-core';
import { buildPropertyUrl, type RawListingDetail } from '../format.js';
import {
  joinNonEmpty,
  streetFromProperty,
  streetFromSuggestion,
  type SuggestionEntry,
} from '../address-format.js';

interface ListingSuggestionsResponse {
  listingSuggestionsSearch?: SuggestionEntry[];
}

interface ListingsResponse {
  listings?: { listings?: RawListingDetail[] };
  listingsBySavedSearchId?: { listings?: RawListingDetail[] };
}

interface SavedSearchResponse {
  savedSearch?: { id?: string; listingIds?: string[] };
}

export type MatchedVia = 'suggestions' | 'search_fallback';

export interface ResolvedByAddress {
  resolved: true;
  url: string;
  listing_id: string;
  address: string;
  matched_via: MatchedVia;
  /** Set when the fallback hit's city disagrees with the caller's input. */
  matched_outside_saved_area?: boolean;
}

export interface UnresolvedByAddress {
  resolved: false;
  error: string;
  query: string;
}

export type ByAddressResult = ResolvedByAddress | UnresolvedByAddress;

export interface ByAddressInput {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
}

export function buildAddressQuery(args: ByAddressInput): string {
  return joinNonEmpty([args.address, args.city, args.state, args.zip], ', ') ?? '';
}

function listingHaystack(raw: RawListingDetail): string {
  const p = raw.property ?? {};
  // UnparsedAddress (listingDetail-level, #25) widens the fuzzy haystack.
  return [
    p.StreetNumber,
    p.StreetDirPrefix,
    p.StreetName,
    p.StreetSuffix,
    p.StreetDirSuffix,
    p.UnitNumber,
    p.City,
    p.PostalCity,
    p.StateOrProvince,
    p.PostalCode,
    raw.UnparsedAddress,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function formatListingAddress(raw: RawListingDetail): string {
  const p = raw.property ?? {};
  const street = streetFromProperty(p);
  const cityState = joinNonEmpty([p.City ?? p.PostalCity, p.StateOrProvince], ', ');
  return joinNonEmpty([street, cityState, p.PostalCode], ', ') ?? '';
}

/**
 * A memoization cache for the fallback pool, keyed on
 * `(groupId, savedSearchId)`. A batch resolver (`onehome_resolve_addresses`)
 * builds one of these per call and threads it through every
 * `resolveByAddressOnce` so the (expensive) saved-search /
 * raw-listings pool is fetched ONCE per distinct scope rather than
 * once per address (perf P1). The single-address tool passes none and
 * each call fetches its own pool.
 */
export type FallbackPoolCache = Map<string, Promise<RawListingDetail[]>>;

function poolCacheKey(
  groupId: string,
  savedSearchId: string | undefined
): string {
  // The separator is U+0000 written as an ESCAPE, not as a literal byte. A
  // raw NUL in the source makes this file `data` to file(1) and BINARY to
  // grep, which then silently reports no matches in it rather than saying it
  // skipped one — a tool-roster scan across this repo under-counted for
  // exactly that reason. The runtime string is identical.
  return `${groupId}\u0000${savedSearchId ?? ''}`;
}

/**
 * Fetch the broader pool the magic-link session can access for the
 * search-fallback rung: the saved-search collection when the
 * consumer-share has one, the raw `listings(groupId)` page otherwise.
 * Pure I/O — no matching. Memoized by the optional `cache` so a batch
 * sharing the same `(groupId, savedSearchId)` scope pulls it once.
 */
async function fetchFallbackPool(
  client: OneHomeClient,
  groupId: string,
  savedSearchId: string | undefined
): Promise<RawListingDetail[]> {
  if (savedSearchId) {
    const ss = await client.graphql<SavedSearchResponse>(
      buildGetSavedSearchBySearchId(savedSearchId)
    );
    const listingIds = ss.savedSearch?.listingIds ?? [];
    if (listingIds.length === 0) return [];
    const data = await client.graphql<ListingsResponse>(
      buildGetSavedListings({
        groupId,
        savedSearchId,
        listingIds,
        // Cap at 200 — typical consumer-share saved searches have O(10-30)
        // curated listings, so one page is enough. Larger saved searches would
        // need a page-walk loop here.
        pageInput: { pageNum: 0, size: Math.min(200, listingIds.length) },
      })
    );
    return data.listingsBySavedSearchId?.listings ?? [];
  }
  const data = await client.graphql<ListingsResponse>(
    buildGetListings({
      groupId,
      browseParameter: { pageInput: { pageNum: 0, size: 200 } },
    })
  );
  return data.listings?.listings ?? [];
}

/**
 * Search-fallback rung: when `ListingSuggestionsSearch` misses, page-
 * walk the broader pool the magic-link session can access (saved-search
 * if the consumer-share has one, raw `listings(groupId)` otherwise) and
 * fuzzy-match the input address tokens. Returns null when there's no
 * group scope to search inside or no listing matches all input tokens.
 *
 * The pool itself is fetched via `fetchFallbackPool`, memoized through
 * the optional `cache` so a batch resolving many addresses against the
 * same `(groupId, savedSearchId)` scope pulls it once (perf P1).
 */
async function searchFallback(
  client: OneHomeClient,
  input: ByAddressInput,
  groupId: string | undefined,
  savedSearchId: string | undefined,
  cache?: FallbackPoolCache
): Promise<RawListingDetail | null> {
  if (!groupId) return null;
  // Canonical realty-core tokenizer keeps the leading numeric street
  // number as an anchor token; bail when the input has nothing matchable.
  if (tokenize(input.address).length === 0) return null;
  let pool: RawListingDetail[];
  if (cache) {
    const key = poolCacheKey(groupId, savedSearchId);
    let cached = cache.get(key);
    if (!cached) {
      cached = fetchFallbackPool(client, groupId, savedSearchId);
      cache.set(key, cached);
    }
    pool = await cached;
  } else {
    pool = await fetchFallbackPool(client, groupId, savedSearchId);
  }
  for (const l of pool) {
    // Skip id-less hits: without a listing id we can't build a usable result
    // (mirrors the suggestions rung's `.find(s => s.id || s.listingId)` guard).
    if (!l.id) continue;
    // Canonical anchored token-equality match (realty-core) — the leading
    // numeric token must appear verbatim in the candidate, so "26 Bear Ln"
    // no longer substring-matches "126 Bear Ln" the old `includes()` loop
    // let through.
    if (addressMatch(input.address, listingHaystack(l)).matched) return l;
  }
  return null;
}

/**
 * Shared resolver — single place where the by-address rung set lives so
 * `onehome_get_by_address` and `onehome_resolve_addresses` walk the
 * same path (parity discipline; issue #42). Rung set (issue #44):
 *   1. `ListingSuggestionsSearch` (magic-link-scoped suggestion search)
 *   2. search-fallback — page-walk the saved-search (or raw listings)
 *      pool bounded by the magic-link `groupId` and fuzzy-match tokens
 */
export async function resolveByAddressOnce(
  client: OneHomeClient,
  input: ByAddressInput,
  groupId?: string,
  poolCache?: FallbackPoolCache
): Promise<ByAddressResult> {
  const query = buildAddressQuery(input);
  const data = await client.graphql<ListingSuggestionsResponse>(
    buildListingSuggestionsSearch({
      browseParameter: query,
      groupId,
    })
  );
  const top = (data.listingSuggestionsSearch ?? []).find(
    (s) => (s.id || s.listingId) && suggestionMatches(input, s)
  );
  if (top) {
    const listingId = (top.id || top.listingId) as string;
    return {
      resolved: true,
      url: buildPropertyUrl(listingId),
      listing_id: listingId,
      address: formatSuggestionAddress(top, query),
      matched_via: 'suggestions',
    };
  }
  // Rung 2: search-fallback. Pulls savedSearchId from the same session
  // context the caller's groupId came from when not explicitly passed.
  const ctx = client.bridgeStatus().sessionContext;
  const hit = await searchFallback(
    client,
    input,
    groupId,
    ctx.savedSearchId,
    poolCache
  );
  if (hit) {
    // searchFallback() filters out id-less hits, so hit.id is non-empty here.
    const listingId = hit.id as string;
    const address = formatListingAddress(hit) || query;
    const out: ResolvedByAddress = {
      resolved: true,
      url: buildPropertyUrl(listingId),
      listing_id: listingId,
      address,
      matched_via: 'search_fallback',
    };
    const inputCity = input.city?.trim().toLowerCase();
    const hitCity = (hit.property?.City ?? hit.property?.PostalCity ?? '')
      .trim()
      .toLowerCase();
    if (inputCity && hitCity && inputCity !== hitCity) {
      out.matched_outside_saved_area = true;
    }
    return out;
  }
  return { resolved: false, error: 'no listing found', query };
}

/**
 * `ListingSuggestionsSearch` is a fuzzy / prefix type-ahead, so its
 * first hit can be a neighbouring or partially-matching listing. Verify
 * it with the same anchored realty-core `addressMatch` the fallback rung
 * uses ("26 Bear Ln" must not accept "126 Bear Ln"). A suggestion that
 * carries no street parts at all can't be verified and is accepted as
 * before — rejecting it would turn every address-less hit into a miss.
 */
function suggestionMatches(input: ByAddressInput, s: SuggestionEntry): boolean {
  const street = streetFromSuggestion(s);
  if (!street) return true;
  const haystack = [street, s.city, s.postalCity, s.stateOrProvince, s.postalCode]
    .filter(Boolean)
    .join(' ');
  return addressMatch(input.address, haystack).matched;
}

function formatSuggestionAddress(s: SuggestionEntry, fallback: string): string {
  const street = streetFromSuggestion(s);
  const cityState = joinNonEmpty([s.city ?? s.postalCity, s.stateOrProvince], ', ');
  const addr = joinNonEmpty([street, cityState, s.postalCode], ', ');
  return addr ?? fallback;
}

export function registerByAddressTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_get_by_address',
    {
      title: 'Resolve a OneHome listing by street address',
      description:
        "Resolve a free-text street address (with optional city/state/zip) to a OneHome listing's canonical portal URL and id in one call. Walks a 2-rung ladder: (1) `ListingSuggestionsSearch` against the magic-link saved-search scope; (2) when that misses, search-fallback — page-walks the broader saved-search (or raw `listings(groupId)`) pool bounded by the same `groupId` and fuzzy-matches input address tokens. Returns `{ url, listing_id, address, resolved, matched_via }` where `matched_via: \"suggestions\" | \"search_fallback\"` reports which rung produced the hit. When no listing matches, returns `{ resolved: false, error: \"no listing found\" }` rather than throwing. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Resolve a OneHome listing by street address',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        address: z
          .string()
          .min(1)
          .describe('Street address line, e.g. "126 Sleeping Bear Ln".'),
        city: z.string().optional().describe('e.g. "Lake Lure"'),
        state: z
          .string()
          .optional()
          .describe('Two-letter state abbreviation, e.g. "NC"'),
        zip: z.string().optional().describe('ZIP code, e.g. "28746"'),
        group_id: z
          .string()
          .optional()
          .describe(
            'Optional OneHome group id to scope the suggestion search. Defaults to the magic-link session context when present.'
          ),
      }),
    },
    // `view` is destructured OFF before anything else touches the input. It
    // is a RESPONSE-shape argument and OneHome has never heard of it, and the
    // whole `input` object goes on to `resolveByAddressOnce` -> the address
    // query builder. That builder reads named fields today, so nothing leaks;
    // two sibling repos shipped a handler with exactly this shape that started
    // sending `view=compact` to a live API the moment its builder began
    // iterating its argument. Removing the key here removes the possibility.
    async ({ view, ...input }) => {
      const ctx = client.bridgeStatus().sessionContext;
      const groupId = input.group_id ?? ctx.groupId;
      const result = await resolveByAddressOnce(client, input, groupId);
      return viewResponse(view, result);
    }
  );
}
