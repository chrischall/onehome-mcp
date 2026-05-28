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
  values: Array<string | number | null | Record<string, unknown>>;
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
  'lot_size',
  'lot_size_acres',
  'year_built',
  'status',
  'hoa_fee',
  'hoa_monthly_usd',
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
      // Object-valued fields (hoa_fee, lot_size, major_change) stay as
      // objects so the summary matches the per-row `rows[].property.*`
      // shape — JSON-encoding them as strings forced callers to re-parse
      // every cell. (Issue #18.)
      if (typeof v === 'object') return v as Record<string, unknown>;
      return null;
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
        "Fetch 2 or more OneHome listings and align their facts side-by-side. Each target may supply `listing_id` (preferred) or `url` (a portal URL). Returns the full per-property record (with `extracted_features` populated) per row. Per-target errors are captured per-row — one bad target will not fail the whole call. Calls are concurrent. The raw `description` is omitted from each row by default (`include_description: true` to keep it). The redundant `summary` table is also opt-in via `include_summary: true` — by default only `rows[]` is returned, which already carries every fact.",
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
        include_description: z
          .boolean()
          .optional()
          .describe(
            'Include the raw `description` (PublicRemarks) on each row. Defaults to `false`.'
          ),
        include_summary: z
          .boolean()
          .optional()
          .describe(
            'Include the pivoted `summary` table (one row per compared field, one column per listing). Defaults to `false` because `rows[].property.*` already carries everything — the summary is roughly 30% of the response weight and only useful for human-readable rendering.'
          ),
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
            row.property = formatListing(listingId, raw, {
              includeDescription: i.include_description,
            });
          } catch (err) {
            row.error = err instanceof Error ? err.message : String(err);
          }
          return row;
        })
      );
      const body: {
        group_id: string | undefined;
        target_count: number;
        summary?: SummaryRow[];
        rows: CompareRow[];
      } = {
        group_id: groupId,
        target_count: i.targets.length,
        rows,
      };
      if (i.include_summary === true) body.summary = buildSummary(rows);
      return textResult(body);
    }
  );
}
