import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import { fetchListingDetail } from './properties.js';
import { formatListing, type FormattedListing } from '../format.js';

export interface CompareTarget {
  listing_id?: string;
  url?: string;
  saved_search_id?: string;
}

interface CompareRow {
  listing_id?: string;
  url?: string;
  property?: FormattedListing;
  error?: string;
}

interface SummaryRow {
  field: string;
  values: Array<string | number | null>;
}

const SUMMARY_FIELDS: Array<keyof FormattedListing> = [
  'address_full',
  'city',
  'state',
  'zip',
  'list_price',
  'price_per_sqft',
  'beds',
  'baths',
  'living_area_sqft',
  'year_built',
  'status',
  'hoa_fee',
  'tax_annual',
];

export function buildSummary(rows: CompareRow[]): SummaryRow[] {
  return SUMMARY_FIELDS.map((field) => ({
    field,
    values: rows.map((r) => {
      if (!r.property) return null;
      const v = (r.property as unknown as Record<string, unknown>)[field];
      if (v === undefined || v === null) return null;
      if (typeof v === 'string' || typeof v === 'number') return v;
      // Stringify object fields (hoa_fee, lot_size, major_change) so the
      // summary table stays flat.
      return JSON.stringify(v);
    }),
  }));
}

export function registerCompareTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_compare_properties',
    {
      title: 'Compare OneHome listings side-by-side',
      description:
        "Fetch 2 or more OneHome listings and align their facts side-by-side. Each target may supply `listing_id` (preferred) or `url` (a portal URL). Returns a compact summary table aligned by field (address, price, beds/baths, sqft, $/sqft, status, HOA, tax, etc.) plus the full per-property record. Per-target errors are captured per-row — one bad target will not fail the whole call. Calls are concurrent.",
      annotations: {
        title: 'Compare OneHome listings side-by-side',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        group_id: z.string().optional(),
        targets: z
          .array(
            z.object({
              listing_id: z.string().optional(),
              url: z.string().optional(),
              saved_search_id: z.string().optional(),
            })
          )
          .min(2)
          .max(8),
      },
    },
    async (i) => {
      const groupId =
        i.group_id ?? client.bridgeStatus().sessionContext.groupId;
      const rows: CompareRow[] = await Promise.all(
        i.targets.map(async (t) => {
          const row: CompareRow = {};
          if (t.listing_id) row.listing_id = t.listing_id;
          if (t.url) row.url = t.url;
          try {
            const { listingId, raw } = await fetchListingDetail(client, {
              group_id: groupId,
              listing_id: t.listing_id,
              url: t.url,
              saved_search_id: t.saved_search_id,
            });
            row.property = formatListing(listingId, raw);
          } catch (err) {
            row.error = err instanceof Error ? err.message : String(err);
          }
          return row;
        })
      );
      return textResult({
        group_id: groupId,
        target_count: i.targets.length,
        summary: buildSummary(rows),
        rows,
      });
    }
  );
}
