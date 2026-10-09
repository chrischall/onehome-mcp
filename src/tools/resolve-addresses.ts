import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { runBoundedBatch } from '@chrischall/mcp-utils';
import {
  retryOnceOnTimeout,
  classifyRowError,
  BRIDGE_CONCURRENCY,
} from '@chrischall/mcp-utils/fetchproxy';
import {
  DEFAULT_ROW_BATCH_DEADLINE_MS,
  errorRow,
  pendingRow,
  type RowErrorFields,
} from '@chrischall/realty-core';
import type { OneHomeClient } from '../client.js';
import { minifiedResult } from '../mcp.js';
import {
  buildAddressQuery,
  resolveByAddressOnce,
  type ByAddressInput,
  type ByAddressResult,
  type FallbackPoolCache,
} from './by-address.js';

/**
 * `onehome_resolve_addresses` — bulk address-to-URL resolver. Mirrors
 * the cohort's structured-row shape (compass/redfin/zillow) and walks
 * the *exact same* 2-rung ladder as `onehome_get_by_address` via the
 * shared `resolveByAddressOnce` helper, so the bulk path can't drift
 * from the single (parity discipline).
 *
 * Fan-out uses the canonical `@fetchproxy/server` bulk helpers:
 * `mapWithConcurrency` bounded by `BRIDGE_CONCURRENCY` (=6),
 * `retryOnceOnTimeout` for transient bridge timeouts, and
 * `classifyRowError` for per-row error wrappers so bridge timeouts
 * surface distinctly from upstream "no listing found" misses.
 */

export const RESOLVE_ADDRESSES_MAX = 100;

interface ResolveRow {
  resolved: boolean;
  url?: string;
  listing_id?: string;
  address?: string;
  error?: string;
  query?: string;
  matched_via?: 'suggestions' | 'search_fallback';
  matched_outside_saved_area?: boolean;
  /** Error / pending rows only (realty-core row fields, fleet-audit#1091). */
  status?: RowErrorFields['status'];
  error_kind?: RowErrorFields['error_kind'];
  retryable?: boolean;
}

/** Test seam: shrink the overall deadline so the suite doesn't wait 45s. */
export interface ResolveAddressesTuning {
  overallDeadlineMs?: number;
}

function toRow(result: ByAddressResult): ResolveRow {
  if (result.resolved) {
    const row: ResolveRow = {
      resolved: true,
      url: result.url,
      listing_id: result.listing_id,
      address: result.address,
      matched_via: result.matched_via,
    };
    if (result.matched_outside_saved_area) {
      row.matched_outside_saved_area = true;
    }
    return row;
  }
  return { resolved: false, error: result.error, query: result.query };
}

export function registerResolveAddressesTools(
  server: McpServer,
  client: OneHomeClient,
  tuning: ResolveAddressesTuning = {}
): void {
  const overallDeadlineMs = tuning.overallDeadlineMs ?? DEFAULT_ROW_BATCH_DEADLINE_MS;
  server.registerTool(
    'onehome_resolve_addresses',
    {
      title: 'Bulk-resolve street addresses to OneHome URLs + listing_ids',
      description:
        `Resolve up to ${RESOLVE_ADDRESSES_MAX} structured addresses to OneHome canonical portal URLs + listing OSK ids in one call. ` +
        'Each input is a `{address, city?, state?, zip?}` object. Output preserves input order; one row per input, ' +
        'either `{resolved: true, url, listing_id, address}` or `{resolved: false, error, query}`; a row that failed (rather than ' +
        'genuinely missed) also carries `status` = `error_kind` and `retryable` — `timeout` / `bridge_down` / `pending` mean retry it, ' +
        'not "no listing". The whole call is bounded by an overall deadline; unsettled rows come back `status: "pending"` with a ' +
        'top-level `pending` count. ' +
        'Walks the exact same 2-rung ladder as `onehome_get_by_address` via the shared helper (rung 1: ' +
        '`ListingSuggestionsSearch` against the magic-link saved-search scope; rung 2: search-fallback page-walking the ' +
        'broader saved-search / raw-listings pool bounded by `groupId`) — bulk and single cannot diverge. ' +
        'Each row surfaces `matched_via: "suggestions" | "search_fallback"` so callers see which rung produced the hit. ' +
        'Concurrent fan-out capped at 6 in flight to avoid swamping the upstream. ' +
        'Per-row errors captured — one bad address never fails the whole batch. ' +
        '`group_id` defaults to the magic-link session context. Read-only; safe to call repeatedly.',
      annotations: {
        title: 'Bulk-resolve street addresses to OneHome URLs + listing_ids',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        addresses: z
          .array(
            z.object({
              address: z
                .string()
                .min(1)
                .describe('Street address line, e.g. "126 Sleeping Bear Ln".'),
              city: z.string().optional().describe('e.g. "Lake Lure"'),
              state: z
                .string()
                .optional()
                .describe('Two-letter state abbreviation, e.g. "NC"'),
              zip: z.string().optional().describe('ZIP code, e.g. "28746"'),
            })
          )
          .min(1)
          .max(RESOLVE_ADDRESSES_MAX)
          .describe(
            `Up to ${RESOLVE_ADDRESSES_MAX} address inputs. For higher counts, batch into multiple calls.`
          ),
        group_id: z
          .string()
          .optional()
          .describe(
            'OneHome group id to scope every row. Defaults to magic-link session context.'
          ),
      }),
    },
    async (input) => {
      const ctx = client.sessionContextForIds({ groupId: input.group_id });
      const groupId = input.group_id ?? ctx.groupId;
      const inputs = input.addresses as ByAddressInput[];
      // Memoize the search-fallback pool across the whole batch: every row
      // that misses suggestions and falls back resolves against the same
      // `(groupId, savedSearchId)` pool, so fetch it once rather than once
      // per address (perf P1). Shared even under concurrent fan-out — the
      // cache stores the in-flight promise so racing rows await one fetch.
      const poolCache: FallbackPoolCache = new Map();
      // mcp-utils `runBoundedBatch` (fleet-audit#1091 — onehome resolve had
      // no deadline): 6 in flight, the whole call bounded by the cohort's
      // 45s deadline, unsettled rows answered `pending`. Failed rows keep
      // `{ resolved: false, error, query }` and gain realty-core's row
      // fields (`status` = `error_kind`, `retryable`), so a timeout —
      // including onehome's own OneHomeRequestTimeoutError, which
      // mcp-utils >= 2.12 retries once and classifies (fleet-audit#1078) —
      // is never read as "no listing at this address".
      const rows = await runBoundedBatch<ByAddressInput, ResolveRow>(
        inputs,
        async (a) =>
          toRow(
            await retryOnceOnTimeout(() =>
              resolveByAddressOnce(client, a, groupId, poolCache)
            )
          ),
        {
          deadlineMs: overallDeadlineMs,
          concurrency: BRIDGE_CONCURRENCY,
          onError: (a, _i, e) =>
            errorRow({ resolved: false, query: buildAddressQuery(a) }, classifyRowError(e)),
          onTimeout: (a) =>
            pendingRow(
              { resolved: false, query: buildAddressQuery(a) },
              'onehome_resolve_addresses'
            ),
        }
      );
      const pending = rows.filter((r) => r.status === 'pending').length;
      const resolved = rows.filter((r) => r.resolved).length;
      return minifiedResult({
        ...(groupId ? { group_id: groupId } : {}),
        count: rows.length,
        resolved,
        unresolved: rows.length - resolved,
        ...(pending > 0 ? { pending } : {}),
        rows,
      });
    }
  );
}
