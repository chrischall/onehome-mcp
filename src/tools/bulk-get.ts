import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import { fetchListingDetail } from './properties.js';
import { formatListing, type FormattedListing } from '../format.js';

/**
 * Upper bound on `listing_ids[]`. A real saved-search consumer share
 * tops out in the low hundreds; 200 covers the realistic "give me
 * everything" call while keeping a single bulk_get tool call cheap
 * enough to fan out concurrently without slamming the GraphQL endpoint
 * with thousands of parallel requests.
 */
export const BULK_GET_MAX = 200;

interface BulkGetRow {
  listing_id: string;
  property?: FormattedListing;
  error?: string;
}

export function registerBulkGetTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_bulk_get',
    {
      title: 'Bulk-fetch OneHome listings by id',
      description:
        `Fetch up to ${BULK_GET_MAX} OneHome listings in a single call. Returns one structured row per input id ` +
        '(no side-by-side summary table — use `onehome_compare_properties` for that). Each row is either ' +
        '`{ listing_id, property }` on success or `{ listing_id, error }` on failure — one bad id never fails the ' +
        'whole call. Calls fan out concurrently against `ListingById`. `extracted_features` is populated per row ' +
        'automatically. The raw `description` (PublicRemarks) is omitted by default — pass `include_description: true` ' +
        'to keep it. `group_id` defaults to the magic-link session context.',
      annotations: {
        title: 'Bulk-fetch OneHome listings by id',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        group_id: z.string().optional(),
        saved_search_id: z.string().optional(),
        listing_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(BULK_GET_MAX)
          .describe(
            `Listing OSK ids to fetch. 1..${BULK_GET_MAX}. For higher counts, batch into multiple calls.`
          ),
        include_description: z
          .boolean()
          .optional()
          .describe(
            'Include the raw `description` (PublicRemarks) on each row. Defaults to `false`.'
          ),
      },
    },
    async (i) => {
      const groupId =
        i.group_id ?? client.bridgeStatus().sessionContext.groupId;
      const savedSearchId =
        i.saved_search_id ?? client.bridgeStatus().sessionContext.savedSearchId;
      const includeDescription = i.include_description ?? false;
      const rows: BulkGetRow[] = await Promise.all(
        i.listing_ids.map(async (id) => {
          const row: BulkGetRow = { listing_id: id };
          try {
            const { listingId, raw } = await fetchListingDetail(client, {
              group_id: groupId,
              listing_id: id,
              saved_search_id: savedSearchId,
            });
            const property = formatListing(listingId, raw);
            // Mirror the P0 default-off behavior: drop the raw
            // PublicRemarks unless the caller opted in.
            if (!includeDescription && property.description !== undefined) {
              delete property.description;
            }
            row.property = property;
          } catch (err) {
            row.error = err instanceof Error ? err.message : String(err);
          }
          return row;
        })
      );
      return textResult({
        ...(groupId ? { group_id: groupId } : {}),
        count: rows.length,
        rows,
      });
    }
  );
}
