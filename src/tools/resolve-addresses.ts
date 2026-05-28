import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  mapWithConcurrency,
  retryOnceOnTimeout,
  classifyRowError,
  BRIDGE_CONCURRENCY,
} from '@fetchproxy/server';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  buildAddressQuery,
  resolveByAddressOnce,
  type ByAddressInput,
  type ByAddressResult,
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
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_resolve_addresses',
    {
      title: 'Bulk-resolve street addresses to OneHome URLs + listing_ids',
      description:
        `Resolve up to ${RESOLVE_ADDRESSES_MAX} structured addresses to OneHome canonical portal URLs + listing OSK ids in one call. ` +
        'Each input is a `{address, city?, state?, zip?}` object. Output preserves input order; one row per input, ' +
        'either `{resolved: true, url, listing_id, address}` or `{resolved: false, error, query}`. ' +
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
      inputSchema: {
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
      },
    },
    async (input) => {
      const ctx = client.bridgeStatus().sessionContext;
      const groupId = input.group_id ?? ctx.groupId;
      const inputs = input.addresses as ByAddressInput[];
      const rows = await mapWithConcurrency(
        inputs,
        BRIDGE_CONCURRENCY,
        async (a) => {
          try {
            return toRow(
              await retryOnceOnTimeout(() =>
                resolveByAddressOnce(client, a, groupId)
              )
            );
          } catch (e) {
            return {
              resolved: false,
              error: classifyRowError(e).message,
              query: buildAddressQuery(a),
            } satisfies ResolveRow;
          }
        }
      );
      const resolved = rows.filter((r) => r.resolved).length;
      return textResult({
        ...(groupId ? { group_id: groupId } : {}),
        count: rows.length,
        resolved,
        unresolved: rows.length - resolved,
        rows,
      });
    }
  );
}
