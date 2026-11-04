import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { OneHomeClient } from '../client.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { UNTRUSTED_CONTENT_RULE, untrustedEnvelope } from '@chrischall/mcp-utils';
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

/** The shortest a title is cut to before the status gives way too. */
const TITLE_FLOOR = 24;

const cut = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, Math.max(n - 1, 0))}…` : s;

/**
 * One listing as one line for the context-groups `brief` view:
 * `<address · price> — <ISO date of the last major change | no date> —
 * <status, change>`, cut to ≤ 120 chars as a WHOLE, title first: the title
 * shortens until the line fits, and if the status alone would still overflow
 * once the title is at its floor, the status is cut too. A title starting with
 * `-- ` or `\` is escaped with one leading `\` so it never reads as a note
 * (the gateway strips one backslash from every item line).
 */
export function briefLine(l: FormattedListing): string {
  const at = l.major_change?.at;
  const date = at && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : 'no date';
  const status =
    [l.status, l.major_change ? humanChange(l.major_change.type) : undefined]
      .filter(Boolean)
      .join(', ') || 'unknown';
  const price = typeof l.list_price === 'number' ? ` · $${USD.format(l.list_price)}` : '';
  const raw = `${l.address_full ?? l.listing_id}${price}`;
  const title = raw.startsWith('-- ') || raw.startsWith('\\') ? `\\${raw}` : raw;
  const sep = ` — ${date} — `;
  const room = BRIEF_MAX - sep.length;
  if (title.length + status.length <= room) return `${title}${sep}${status}`;
  const titleRoom = Math.max(room - status.length, Math.min(title.length, TITLE_FLOOR));
  const shown = cut(title, titleRoom);
  return `${shown}${sep}${cut(status, room - shown.length)}`;
}

/** Who writes the brief lines' text: the listing feed, not this MCP. */
const BRIEF_WHO_WROTE =
  'Listing addresses and statuses come from the MLS listing feed, written by listing agents.';

/**
 * The brief answer: the lines plus their notes (`-- none` when there is
 * nothing, `-- N of M shown` when the saved search holds more listings than
 * this page), inside the untrusted-data envelope as `data: string[]`, minified.
 */
function briefResponse(listings: FormattedListing[], total: number): CallToolResult {
  const lines = listings.map(briefLine);
  if (lines.length === 0) lines.push('-- none');
  else if (total > listings.length) lines.push(`-- ${listings.length} of ${total} shown`);
  const payload = untrustedEnvelope(lines, { note: `${BRIEF_WHO_WROTE} ${UNTRUSTED_CONTENT_RULE}` });
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** The page's own `totalElements` when it reports one, else the saved search's id count. */
function totalOf(pageInfo: unknown, fallback: number): number {
  const t = (pageInfo as { totalElements?: unknown } | null | undefined)?.totalElements;
  return typeof t === 'number' && Number.isFinite(t) ? t : fallback;
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
        'status, change` (e.g. a new listing or a price decrease), inside the ' +
        'untrusted-data envelope as `data: string[]`, with `-- none` for an empty ' +
        'saved search and `-- N of M shown` when the page holds fewer listings ' +
        'than the search.',
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
              'last change (or "no date") — status, change — in the untrusted-data ' +
              'envelope, with "-- " note lines for an empty or partial page.'
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
        if (i.view === 'brief') return briefResponse([], 0);
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
        return briefResponse(
          formattedListings,
          totalOf(data.listingsBySavedSearchId?.pageInfo, listingIds.length)
        );
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
