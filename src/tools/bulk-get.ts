import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  mapWithConcurrency,
  retryOnceOnTimeout,
  classifyRowError,
  BRIDGE_CONCURRENCY,
} from '@chrischall/mcp-utils/fetchproxy';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import { fetchListingDetail } from './properties.js';
import { formatListing, type FormattedListing } from '../format.js';

// Max input listing_ids per call; sized to cover a full consumer saved-search share.
// Concurrent fan-out is bounded by `BRIDGE_CONCURRENCY` (=6) so a 200-id
// batch trickles through the bridge instead of swamping it.
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
        'whole call. Calls fan out concurrently against `ListingById`, capped at 6 in flight to avoid swamping the ' +
        'bridge; transient bridge timeouts are retried once per row before being captured as an error. ' +
        '`extracted_features` is populated per row ' +
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
      const ctx = client.bridgeStatus().sessionContext;
      const groupId = i.group_id ?? ctx.groupId;
      const savedSearchId = i.saved_search_id ?? ctx.savedSearchId;
      const includeDescription = i.include_description ?? false;
      const rows = await mapWithConcurrency(
        i.listing_ids,
        BRIDGE_CONCURRENCY,
        async (id) => {
          const row: BulkGetRow = { listing_id: id };
          try {
            const { listingId, raw } = await retryOnceOnTimeout(() =>
              fetchListingDetail(client, {
                group_id: groupId,
                listing_id: id,
                saved_search_id: savedSearchId,
              })
            );
            row.property = formatListing(listingId, raw, {
              includeDescription,
            });
          } catch (err) {
            row.error = classifyRowError(err).message;
          }
          return row;
        }
      );
      return textResult({
        ...(groupId ? { group_id: groupId } : {}),
        count: rows.length,
        rows,
      });
    }
  );
}
