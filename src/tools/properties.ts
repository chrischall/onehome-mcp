import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import { buildListingById } from '../queries.js';
import { extractListingId } from '../url.js';
import { formatListing, type FormattedListing, type RawListingDetail } from '../format.js';

interface ListingByIdResponse {
  listingDetail?: RawListingDetail;
}

/**
 * Shared helper for any tool that needs a fully-inflated listing
 * record (properties, photos, compare). Centralizes:
 *
 *   - listing-id parsing (accepts URL or raw id)
 *   - GraphQL call with the standard `(listingId, groupId)` shape
 *   - error mapping when the listing isn't accessible
 */
export async function fetchListingDetail(
  client: OneHomeClient,
  args: { listing_id?: string; url?: string; group_id?: string; saved_search_id?: string }
): Promise<{ listingId: string; raw: RawListingDetail }> {
  const id = args.listing_id ?? (args.url ? extractListingId(args.url) : null);
  if (!id) {
    throw new Error(
      'onehome_get_property: provide either `listing_id` or a portal URL ' +
        '(e.g. https://portal.onehome.com/en-US/properties/<id>).'
    );
  }
  const ctx = client.bridgeStatus().sessionContext;
  const groupId = args.group_id ?? ctx.groupId;
  if (!groupId) {
    throw new Error(
      'onehome_get_property: no group_id supplied and the MCP did not ' +
        'bootstrap one from the magic-link context. Pass one explicitly ' +
        '(try `onehome_get_groups`).'
    );
  }
  const savedSearchId = args.saved_search_id ?? ctx.savedSearchId;
  const data = await client.graphql<ListingByIdResponse>(
    buildListingById({
      listingId: id,
      groupId,
      savedSearchId,
    })
  );
  if (!data.listingDetail) {
    throw new Error(
      `onehome_get_property: listing ${id} not found within group ${groupId}. ` +
        'Verify the listing belongs to this OneHome group (try a different group_id).'
    );
  }
  return { listingId: id, raw: data.listingDetail };
}

export type { FormattedListing } from '../format.js';

export function registerPropertyTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_get_property',
    {
      title: 'Fetch full details for a OneHome listing',
      description:
        'Fetch full details for a single OneHome listing by id or portal URL. Returns address, list / close / previous price, $/sqft, beds/baths/sqft, lot size (raw `lot_size` {area, units} plus the derived `lot_size_acres` — null, never 0, for condos / lotless listings), year built, lat/lng, status, HOA fee, annual tax, virtual-tour URL, the primary photo, and an `extracted_features` block (lake_front, hot_tub, basement, furnished, dock, community) keyword-parsed from the description. The raw `description` (PublicRemarks) is omitted by default — pass `include_description: true` to keep it; in most cases the extracted features cover what callers need. OneHome scopes every listing to a group/market — `group_id` defaults to the magic-link session context; pass it explicitly only if you need to query a different group.',
      annotations: {
        title: 'Fetch full details for a OneHome listing',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        group_id: z.string().optional(),
        listing_id: z.string().optional(),
        url: z.string().optional(),
        saved_search_id: z.string().optional(),
        include_description: z
          .boolean()
          .optional()
          .describe(
            'Include the raw `description` (PublicRemarks) in the response. Defaults to `false` — `extracted_features` is always populated and usually sufficient.'
          ),
      },
    },
    async (i) => {
      const { listingId, raw } = await fetchListingDetail(client, {
        group_id: i.group_id,
        listing_id: i.listing_id,
        url: i.url,
        saved_search_id: i.saved_search_id,
      });
      return textResult(
        formatListing(listingId, raw, { includeDescription: i.include_description })
      );
    }
  );
}
