import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { OneHomeClient } from '../client.js';
import { minifiedResult } from '../mcp.js';
import {
  buildGetSavedListings,
  buildGetSavedSearchBySearchId,
} from '../queries.js';
import {
  formatListing,
  type FormattedListing,
  type RawListingDetail,
} from '../format.js';
import { homeMeta, SAVED_SEARCH_ALIASES } from './hints.js';
import {
  formatSavedSearch,
  type FormattedSavedSearch,
  type RawSavedSearch,
} from './saved.js';

const BRIEF_MAX = 120;
const USD = new Intl.NumberFormat('en-US');

/** `NewListing` → `new listing`, `PriceDecrease` → `price decrease`. */
function humanChange(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * One listing as one line for the context-groups `brief` view:
 * `<address · price> — <ISO date of the last major change | no date> —
 * <status, change>`, at most 120 chars (the title is what gives way).
 */
export function briefLine(l: FormattedListing): string {
  const at = l.major_change?.at;
  const date = at && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : 'no date';
  const status =
    [l.status, l.major_change ? humanChange(l.major_change.type) : undefined]
      .filter(Boolean)
      .join(', ') || 'unknown';
  const tail = ` — ${date} — ${status}`;
  const price = typeof l.list_price === 'number' ? ` · $${USD.format(l.list_price)}` : '';
  const title = `${l.address_full ?? l.listing_id}${price}`;
  const room = BRIEF_MAX - tail.length;
  return (title.length > room ? `${title.slice(0, room - 1)}…` : title) + tail;
}

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
        'full description for a specific listing. `view: "brief"` answers one ' +
        'line per listing instead: `address · price — date of its last change — ' +
        'status, change` (e.g. a new listing or a price decrease).',
      _meta: homeMeta('whats-new', { canonical: true, aliases: SAVED_SEARCH_ALIASES }),
      annotations: {
        title: 'Fetch a saved search and inflate its listings in one call',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
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
        view: z
          .enum(['full', 'brief'])
          .optional()
          .describe(
            '"full" (default) returns the saved search and its listing records; ' +
              '"brief" returns one line per listing: address · price — date of its ' +
              'last change (or "no date") — status, change.'
          ),
      }),
    },
    async (i) => {
      // Defaults come from the session that owns the supplied id, not the
      // active one (fleet-audit#1077).
      const ctx = client.sessionContextForIds({
        groupId: i.group_id,
        savedSearchId: i.saved_search_id,
      });
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
        if (i.view === 'brief') return { content: [{ type: 'text' as const, text: '' }] };
        return minifiedResult({
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
      if (i.view === 'brief') {
        return {
          content: [{ type: 'text' as const, text: formattedListings.map(briefLine).join('\n') }],
        };
      }
      return minifiedResult({
        saved_search: formattedSavedSearch,
        group_id: groupId,
        page_info: data.listingsBySavedSearchId?.pageInfo ?? null,
        count: formattedListings.length,
        listings: formattedListings,
      });
    }
  );
}
