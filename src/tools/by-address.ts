import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  buildGetListings,
  buildGetSavedListings,
  buildGetSavedSearchBySearchId,
  buildListingSuggestionsSearch,
} from '../queries.js';
import { buildPropertyUrl, type RawListingDetail } from '../format.js';

interface SuggestionEntry {
  id?: string;
  listingId?: string;
  postalCode?: string;
  city?: string;
  postalCity?: string;
  stateOrProvince?: string;
  streetName?: string;
  streetNumber?: string;
  streetSuffix?: string;
  streetDirPrefix?: string;
  streetDirSuffix?: string;
  unitNumber?: string;
}

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

function joinNonEmpty(parts: Array<string | undefined>, sep = ' '): string {
  return parts.map((p) => (p ?? '').trim()).filter((p) => p.length > 0).join(sep);
}

export interface ByAddressInput {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
}

export function buildAddressQuery(args: ByAddressInput): string {
  return joinNonEmpty([args.address, args.city, args.state, args.zip], ', ');
}

/**
 * Lowercase, punctuation-stripped, whitespace-split tokens used for
 * fuzzy address matching in the search-fallback rung. Drops tokens
 * shorter than 3 chars so a stray "St" or "1" can't dominate.
 */
function addressTokens(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[#.,]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function listingHaystack(raw: RawListingDetail): string {
  const p = raw.property ?? {};
  const cp = raw.customProperty ?? {};
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
    cp.UnparsedAddress,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function formatListingAddress(raw: RawListingDetail): string {
  const p = raw.property ?? {};
  const street = joinNonEmpty([
    p.StreetNumber,
    p.StreetDirPrefix,
    p.StreetName,
    p.StreetSuffix,
    p.StreetDirSuffix,
    p.UnitNumber ? `#${p.UnitNumber}` : undefined,
  ]);
  const cityState = joinNonEmpty([p.City ?? p.PostalCity, p.StateOrProvince], ', ');
  return joinNonEmpty([street, cityState, p.PostalCode], ', ');
}

/**
 * Search-fallback rung: when `ListingSuggestionsSearch` misses, page-
 * walk the broader pool the magic-link session can access (saved-search
 * if the consumer-share has one, raw `listings(groupId)` otherwise) and
 * fuzzy-match the input address tokens. Returns null when there's no
 * group scope to search inside or no listing matches all input tokens.
 */
async function searchFallback(
  client: OneHomeClient,
  input: ByAddressInput,
  groupId: string | undefined,
  savedSearchId: string | undefined
): Promise<RawListingDetail | null> {
  if (!groupId) return null;
  const tokens = addressTokens(input.address);
  if (tokens.length === 0) return null;
  let pool: RawListingDetail[] = [];
  if (savedSearchId) {
    const ss = await client.graphql<SavedSearchResponse>(
      buildGetSavedSearchBySearchId(savedSearchId)
    );
    const listingIds = ss.savedSearch?.listingIds ?? [];
    if (listingIds.length === 0) return null;
    const data = await client.graphql<ListingsResponse>(
      buildGetSavedListings({
        groupId,
        savedSearchId,
        listingIds,
        pageInput: { pageNum: 0, size: Math.min(200, listingIds.length) },
      })
    );
    pool = data.listingsBySavedSearchId?.listings ?? [];
  } else {
    const data = await client.graphql<ListingsResponse>(
      buildGetListings({
        groupId,
        browseParameter: { pageInput: { pageNum: 0, size: 200 } },
      })
    );
    pool = data.listings?.listings ?? [];
  }
  for (const l of pool) {
    const haystack = listingHaystack(l);
    if (tokens.every((t) => haystack.includes(t))) return l;
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
  groupId?: string
): Promise<ByAddressResult> {
  const query = buildAddressQuery(input);
  const data = await client.graphql<ListingSuggestionsResponse>(
    buildListingSuggestionsSearch({
      browseParameter: query,
      groupId,
    })
  );
  const top = (data.listingSuggestionsSearch ?? []).find(
    (s) => s.id || s.listingId
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
  const hit = await searchFallback(client, input, groupId, ctx.savedSearchId);
  if (hit) {
    const listingId = (hit.id ?? '') as string;
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

function formatSuggestionAddress(s: SuggestionEntry, fallback: string): string {
  const street = joinNonEmpty([
    s.streetNumber,
    s.streetDirPrefix,
    s.streetName,
    s.streetSuffix,
    s.streetDirSuffix,
    s.unitNumber ? `#${s.unitNumber}` : undefined,
  ]);
  const cityState = joinNonEmpty([s.city ?? s.postalCity, s.stateOrProvince], ', ');
  const addr = joinNonEmpty([street, cityState, s.postalCode], ', ');
  return addr || fallback;
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
      inputSchema: {
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
      },
    },
    async (input) => {
      const ctx = client.bridgeStatus().sessionContext;
      const groupId = input.group_id ?? ctx.groupId;
      const result = await resolveByAddressOnce(client, input, groupId);
      return textResult(result);
    }
  );
}
