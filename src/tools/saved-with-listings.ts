import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  buildGetSavedListings,
  buildGetSavedSearchBySearchId,
} from '../queries.js';
import { formatListing, type RawListingDetail } from '../format.js';
import {
  formatSavedSearch,
  type FormattedSavedSearch,
  type RawSavedSearch,
} from './saved.js';

interface SavedListingsResponse {
  listingsBySavedSearchId?: {
    pageInfo?: unknown;
    listings?: RawListingDetail[];
  };
}

export function registerSavedWithListingsTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_get_saved_search_with_listings',
    {
      title: 'Fetch a saved search and inflate its listings in one call',
      description:
        'Combo tool: the "show me my saved homes" flow in a single round trip. ' +
        'Internally runs `GetSavedSearchBySearchId` to fetch the saved search ' +
        '(name, filters, polygon, listingIds) and then `GetSavedListings` to ' +
        'inflate those listingIds into full property records — the same two-call ' +
        'sequence as calling `onehome_get_saved_search` followed by ' +
        '`onehome_search_properties(saved_search_id=...)`, but exposed as one tool ' +
        'so the magic-link-to-listings consumer flow is a single MCP call. Returns ' +
        '`{ saved_search, listings, count, page_info }`. Both `saved_search_id` ' +
        'and `group_id` default to the magic-link session context. Sort defaults to ' +
        '`property.MajorChangeTimestamp DESC` (Newest). Listings are returned via ' +
        'the GraphQL listing-card projection (`buildGetSavedListings`), which does ' +
        'NOT include `PublicRemarks` — so there is no raw `description` to opt back ' +
        'into here. Use `onehome_get_property(listing_id)` per row when you need the ' +
        'full description for a specific listing.',
      annotations: {
        title: 'Fetch a saved search and inflate its listings in one call',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        saved_search_id: z.string().optional(),
        group_id: z.string().optional(),
        page_num: z.number().int().nonnegative().optional(),
        page_size: z.number().int().positive().max(200).optional(),
        sort_field: z
          .string()
          .optional()
          .describe(
            'GraphQL dotted-path, e.g. property.MajorChangeTimestamp or property.ListPrice'
          ),
        sort_order: z.enum(['ASC', 'DESC']).optional(),
        include_dislikes: z.boolean().optional(),
      },
    },
    async (i) => {
      const ctx = client.bridgeStatus().sessionContext;
      const savedSearchId = i.saved_search_id ?? ctx.savedSearchId;
      if (!savedSearchId) {
        throw new Error(
          'onehome_get_saved_search_with_listings: no saved_search_id supplied ' +
            'and the MCP did not bootstrap one from the magic-link context. Pass ' +
            'one explicitly, or run with ONEHOME_MAGIC_LINK so the MCP can derive ' +
            'a default from the checkToken response.'
        );
      }
      const groupId = i.group_id ?? ctx.groupId;
      if (!groupId) {
        throw new Error(
          'onehome_get_saved_search_with_listings: no group_id supplied and the ' +
            'MCP did not bootstrap one from the magic-link context. Pass one ' +
            'explicitly (try `onehome_get_groups` to discover ids).'
        );
      }
      const pageNum = i.page_num ?? 0;
      const pageSize = i.page_size ?? 50;
      const includeDislikes = i.include_dislikes ?? false;
      const sort = i.sort_field
        ? { name: i.sort_field, order: i.sort_order ?? 'DESC' }
        : undefined;

      // Step 1: fetch the saved search (name, filters, polygon, listingIds).
      const ssData = await client.graphql<{ savedSearch?: RawSavedSearch }>(
        buildGetSavedSearchBySearchId(savedSearchId)
      );
      if (!ssData.savedSearch) {
        throw new Error(
          `onehome_get_saved_search_with_listings: saved search ${savedSearchId} ` +
            'not found or not accessible with the current session token.'
        );
      }
      const formattedSavedSearch: FormattedSavedSearch = formatSavedSearch(
        ssData.savedSearch,
        { include_listing_ids: false }
      );
      const listingIds = ssData.savedSearch.listingIds ?? [];

      // Step 2: short-circuit when the saved search has no listings.
      if (listingIds.length === 0) {
        return textResult({
          saved_search: formattedSavedSearch,
          group_id: groupId,
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

      // Step 3: inflate the listingIds into full property records.
      const data = await client.graphql<SavedListingsResponse>(
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
      // FRAGMENT_LISTING_CARD has no PublicRemarks; no description ever surfaces here.
      const formattedListings = listings.map((l) => formatListing(l.id ?? '', l));
      return textResult({
        saved_search: formattedSavedSearch,
        group_id: groupId,
        page_info: data.listingsBySavedSearchId?.pageInfo ?? null,
        count: formattedListings.length,
        listings: formattedListings,
      });
    }
  );
}
