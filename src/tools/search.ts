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
import { buildPropertyUrl, formatListing, type RawListingDetail } from '../format.js';

interface ListingsResponse {
  listings?: { pageInfo?: unknown; listings?: RawListingDetail[] };
  listingsBySavedSearchId?: { pageInfo?: unknown; listings?: RawListingDetail[] };
}

interface SuggestionEntry {
  id?: string;
  listingId?: string;
  postalCode?: string;
  city?: string;
  postalCity?: string;
  stateOrProvince?: string;
  streetName?: string;
  streetNumber?: string;
  streetAdditionalInfo?: string;
  unitNumber?: string;
  streetSuffix?: string;
  streetDirPrefix?: string;
  streetDirSuffix?: string;
  bedroomsTotal?: number;
  bathroomsTotalInteger?: number;
  listPrice?: number;
  media?: {
    Image?: { Thumbnail?: { mediaUrl?: string; width?: number; height?: number } };
  }[];
}

function joinNonEmpty(parts: Array<string | undefined>, sep = ' '): string {
  return parts.map((p) => (p ?? '').trim()).filter((p) => p.length > 0).join(sep);
}

function formatSuggestion(s: SuggestionEntry): Record<string, unknown> {
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
  const photo = s.media?.[0]?.Image?.Thumbnail?.mediaUrl;
  const listingId = s.id ?? s.listingId;
  return {
    listing_id: listingId,
    source_listing_id: s.listingId,
    url: listingId ? buildPropertyUrl(listingId) : undefined,
    address_full: addr || undefined,
    street: street || undefined,
    city: s.city ?? s.postalCity,
    state: s.stateOrProvince,
    zip: s.postalCode,
    beds: s.bedroomsTotal,
    baths: s.bathroomsTotalInteger,
    list_price: s.listPrice,
    primary_thumbnail_url: photo,
  };
}

interface RawSavedSearch {
  id?: string;
  name?: string;
  listingIds?: string[];
}

export function registerSearchTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_search_properties',
    {
      title: 'Search listings inside a OneHome group / saved share',
      description:
        "Fetch listings inside a OneHome consumer-share. Two modes:\n\n  - With `saved_search_id`: fetch the agent-curated collection (the standard 'Homes at <name>' view). The MCP first resolves the saved search's listingIds and then inflates them via listingsBySavedSearchId — this is the only mode that works for non-agent consumer accounts.\n  - With just `group_id` and no `saved_search_id`: try the raw `listings(groupId, browseParameter)` endpoint. If that returns 0 (the access-restricted shape consumer-shares hit) AND the session context has a `savedSearchId`, the tool transparently falls back to the saved-search path. If there's no fallback target it raises a clear error rather than silently returning empty.\n\nBoth args default from the MCP's bootstrapped session context (the magic-link checkToken response) when neither is passed explicitly. Sort is `MajorChangeTimestamp DESC` ('Newest') unless overridden. `include_dislikes: false` by default — flip it on to include listings you've thumbs-downed in OneHome.\n\nListings here are returned via the GraphQL listing-card projection, which does NOT include `PublicRemarks` — so there is no `description` field on search results and no `include_description` flag to opt into one. Each listing carries the structured `extracted_features` object instead. Use `onehome_get_property(listing_id)` per row when you need the full description for a specific listing.",
      annotations: {
        title: 'Search listings inside a OneHome group / saved share',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        group_id: z.string().optional(),
        saved_search_id: z.string().optional(),
        page_num: z.number().int().nonnegative().optional(),
        page_size: z.number().int().positive().max(200).optional(),
        sort_field: z
          .string()
          .optional()
          .describe('GraphQL dotted-path, e.g. property.MajorChangeTimestamp or property.ListPrice'),
        sort_order: z.enum(['ASC', 'DESC']).optional(),
        include_dislikes: z.boolean().optional(),
      },
    },
    async (i) => {
      const ctx = client.bridgeStatus().sessionContext;
      const resolvedGroupId: string | undefined = i.group_id ?? ctx.groupId;
      if (!resolvedGroupId) {
        throw new Error(
          'onehome_search_properties: no group_id supplied and the MCP did ' +
            'not bootstrap one from the magic-link context. Pass one ' +
            'explicitly (try `onehome_get_groups` to discover ids).'
        );
      }
      // Closure-capturable narrowed value — inside `runSavedSearchPath`
      // TS would otherwise widen back to `string | undefined`.
      const groupId: string = resolvedGroupId;
      const pageNum = i.page_num ?? 0;
      const pageSize = i.page_size ?? 50;
      const includeDislikes = i.include_dislikes ?? false;
      const sort =
        i.sort_field
          ? { name: i.sort_field, order: i.sort_order ?? 'DESC' }
          : undefined;
      // If the caller explicitly passed `group_id` without `saved_search_id`,
      // they want the raw `listings(groupId)` form. Don't default
      // `savedSearchId` from session context here — we'll fall back to it
      // separately if the raw call comes back empty (issue #27). When
      // BOTH args are absent we keep the historical behaviour and default
      // straight from context (skipping the wasted raw round-trip).
      const callerExplicitGroupOnly =
        i.group_id !== undefined && i.saved_search_id === undefined;
      const savedSearchId = callerExplicitGroupOnly
        ? i.saved_search_id
        : i.saved_search_id ?? ctx.savedSearchId;

      async function runSavedSearchPath(
        ssId: string
      ): Promise<ReturnType<typeof textResult>> {
        // 1. Fetch the saved search to get its listingIds (osks).
        const ssData = await client.graphql<{ savedSearch?: RawSavedSearch }>(
          buildGetSavedSearchBySearchId(ssId)
        );
        const listingIds = ssData.savedSearch?.listingIds ?? [];
        if (listingIds.length === 0) {
          return textResult({
            group_id: groupId,
            saved_search_id: ssId,
            saved_search_name: ssData.savedSearch?.name,
            page_info: {
              totalElements: 0,
              totalPages: 0,
              pageNumber: pageNum,
              pageSize: 0,
            },
            count: 0,
            listings: [],
          });
        }
        // 2. Inflate them via listingsBySavedSearchId.
        const data = await client.graphql<ListingsResponse>(
          buildGetSavedListings({
            groupId,
            savedSearchId: ssId,
            listingIds,
            sort,
            pageInput: { pageNum, size: pageSize },
            includeDislikes,
          })
        );
        const listings = data.listingsBySavedSearchId?.listings ?? [];
        return textResult({
          group_id: groupId,
          saved_search_id: ssId,
          saved_search_name: ssData.savedSearch?.name,
          page_info: data.listingsBySavedSearchId?.pageInfo ?? null,
          count: listings.length,
          listings: listings.map((l) => formatListing(l.id ?? '', l)),
        });
      }

      if (savedSearchId) {
        return runSavedSearchPath(savedSearchId);
      }
      // Raw `listings(...)` form — agent groups have direct results here;
      // consumer-share groups come back empty (the access-restricted path).
      const data = await client.graphql<ListingsResponse>(
        buildGetListings({
          groupId,
          browseParameter: {
            ...(sort ? { sort } : {}),
            pageInput: { pageNum, size: pageSize },
          },
          includeDislikes,
        })
      );
      const listings = data.listings?.listings ?? [];
      if (listings.length === 0) {
        // Issue #27: consumer-share groups always return 0 from this
        // endpoint. If the magic-link session bootstrapped a savedSearchId
        // we can transparently retry against the saved-search path
        // (almost certainly what the caller wanted). Otherwise surface a
        // clear error so the caller knows they hit the access-restricted
        // shape rather than a genuinely empty group.
        if (ctx.savedSearchId) {
          return runSavedSearchPath(ctx.savedSearchId);
        }
        throw new Error(
          `onehome_search_properties: raw listings(groupId=${groupId}) returned 0 ` +
            'and the session context has no saved_search_id to fall back to. ' +
            'This usually means a consumer-share account: the raw listings ' +
            'endpoint is agent-only and consumer-shares only have a ' +
            'saved-search view. Re-run with an explicit `saved_search_id` ' +
            '(try `onehome_get_saved_search` to discover one), or set ' +
            'ONEHOME_MAGIC_LINK so the MCP can bootstrap the consumer ' +
            'context (group + saved-search ids).'
        );
      }
      return textResult({
        group_id: groupId,
        page_info: data.listings?.pageInfo ?? null,
        count: listings.length,
        listings: listings.map((l) => formatListing(l.id ?? '', l)),
      });
    }
  );

  server.registerTool(
    'onehome_search_suggestions',
    {
      title: 'Free-text suggestion search across MLS feeds',
      description:
        'Cross-feed suggestion search by address, MLS number, or partial query. Bypasses the group/saved-search structure and hits the global suggestion endpoint — useful for "find an address" or "look up by MLS number". Returns id, address parts, beds/baths, list price, thumbnail per match. Inflate any result with `onehome_get_property`. Optional `group_id` scopes suggestions to one OneHome market.',
      annotations: {
        title: 'Free-text suggestion search across MLS feeds',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        query: z.string().min(1),
        group_id: z.string().optional(),
      },
    },
    async (i) => {
      const ctx = client.bridgeStatus().sessionContext;
      const data = await client.graphql<{
        listingSuggestionsSearch?: SuggestionEntry[];
      }>(
        buildListingSuggestionsSearch({
          browseParameter: i.query,
          groupId: i.group_id ?? ctx.groupId,
        })
      );
      const items = data.listingSuggestionsSearch ?? [];
      return textResult({
        query: i.query,
        count: items.length,
        suggestions: items.map(formatSuggestion),
      });
    }
  );
}
