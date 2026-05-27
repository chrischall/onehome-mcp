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
        "Fetch listings inside a OneHome consumer-share. Two modes:\n\n  - With `saved_search_id`: fetch the agent-curated collection (the standard 'Homes at <name>' view). The MCP first resolves the saved search's listingIds and then inflates them via listingsBySavedSearchId — this is the only mode that works for non-agent consumer accounts.\n  - With just `group_id` and no `saved_search_id`: fall back to the raw `listings(groupId, browseParameter)` endpoint. Often returns 0 results for consumer-share accounts because the group itself isn't a listing collection — supply `saved_search_id` for that.\n\nBoth args default from the MCP's bootstrapped session context (the magic-link checkToken response). Sort is `MajorChangeTimestamp DESC` ('Newest') unless overridden. `include_dislikes: false` by default — flip it on to include listings you've thumbs-downed in OneHome.",
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
      const groupId = i.group_id ?? ctx.groupId;
      if (!groupId) {
        throw new Error(
          'onehome_search_properties: no group_id supplied and the MCP did ' +
            'not bootstrap one from the magic-link context. Pass one ' +
            'explicitly (try `onehome_get_groups` to discover ids).'
        );
      }
      const savedSearchId = i.saved_search_id ?? ctx.savedSearchId;
      const pageNum = i.page_num ?? 0;
      const pageSize = i.page_size ?? 50;
      const includeDislikes = i.include_dislikes ?? false;
      const sort =
        i.sort_field
          ? { name: i.sort_field, order: i.sort_order ?? 'DESC' }
          : undefined;
      if (savedSearchId) {
        // 1. Fetch the saved search to get its listingIds (osks).
        const ssData = await client.graphql<{ savedSearch?: RawSavedSearch }>(
          buildGetSavedSearchBySearchId(savedSearchId)
        );
        const listingIds = ssData.savedSearch?.listingIds ?? [];
        if (listingIds.length === 0) {
          return textResult({
            group_id: groupId,
            saved_search_id: savedSearchId,
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
            savedSearchId,
            listingIds,
            sort,
            pageInput: { pageNum, size: pageSize },
            includeDislikes,
          })
        );
        const listings = data.listingsBySavedSearchId?.listings ?? [];
        return textResult({
          group_id: groupId,
          saved_search_id: savedSearchId,
          saved_search_name: ssData.savedSearch?.name,
          page_info: data.listingsBySavedSearchId?.pageInfo ?? null,
          count: listings.length,
          listings: listings.map((l) => formatListing(l.id ?? '', l)),
        });
      }
      // No saved-search context — fall back to the raw `listings(...)` form.
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
