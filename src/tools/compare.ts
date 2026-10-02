import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { runBoundedBatch } from '@chrischall/mcp-utils';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  retryOnceOnTimeout,
} from '@chrischall/mcp-utils/fetchproxy';
import { pivotSummary, runRowBatch } from '@chrischall/realty-core';
import type { OneHomeClient } from '../client.js';
import { minifiedResult } from '../mcp.js';
import { viewArg, viewResponse } from '../view.js';
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
}

interface SummaryRow {
  field: string;
  values: unknown[];
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

export function buildSummary(rows: ReadonlyArray<CompareRow>): SummaryRow[] {
  // realty-core `pivotSummary` (fleet-audit#1091): each cell is the row's
  // value verbatim — object-valued fields (hoa_fee, lot_size) stay objects
  // so the summary matches `rows[].property.*` (issue #18); `undefined` /
  // failed row → null. (onehome used to null booleans too; none of these
  // fields is boolean, and the cohort rule is verbatim.)
  return pivotSummary<FormattedListing>(rows, SUMMARY_FIELDS);
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
      inputSchema: z.object({
        view: viewArg(),
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
      }),
    },
    async (i) => {
      // Only forward an explicit group_id; fetchListingDetail defaults
      // each target from the session its listing id routes to.
      const groupId = i.group_id;
      // realty-core `runRowBatch` (fleet-audit#1091): replaces an unbounded
      // `Promise.all` — now 6 in flight, deadline-bounded (45s), timeouts
      // (incl. OneHomeRequestTimeoutError, fleet-audit#1078) retried once,
      // and every failed row classified with `status` = `error_kind` +
      // `retryable`.
      const envelope = await runRowBatch(
        i.targets,
        async (t) => {
          const { listingId, raw } = await fetchListingDetail(client, {
            group_id: groupId,
            listing_id: t.listing_id,
            url: t.url,
            saved_search_id: t.saved_search_id,
          });
          return {
            property: formatListing(listingId, raw, {
              includeDescription: i.include_description,
            }),
          };
        },
        {
          kit: { runBoundedBatch, classifyRowError, retryOnceOnTimeout },
          toolLabel: 'onehome_compare_properties',
          rowBase: (t) => ({
            ...(t.listing_id ? { listing_id: t.listing_id } : {}),
            ...(t.url ? { url: t.url } : {}),
          }),
          concurrency: BRIDGE_CONCURRENCY,
          resultsKey: 'rows',
        }
      );
      const body: {
        group_id: string | undefined;
        target_count: number;
        summary?: SummaryRow[];
      } & typeof envelope = {
        group_id: groupId ?? client.sessionContextFor().groupId,
        target_count: i.targets.length,
        ...envelope,
      };
      if (i.include_summary === true) body.summary = buildSummary(envelope.rows);
      return viewResponse((i as { view?: string }).view, body);
    }
  );
}
