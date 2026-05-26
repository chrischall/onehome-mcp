import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import { buildListingSuggestionsSearch } from '../queries.js';
import { buildPropertyUrl } from '../format.js';

interface SuggestionEntry {
  id?: string;
  listingId?: string;
  postalCode?: string;
  city?: string;
  postalCity?: string;
  stateOrProvince?: string;
  streetName?: string;
  streetNumber?: string;
  streetSuffix?: string;
  streetDirPrefix?: string;
  streetDirSuffix?: string;
  unitNumber?: string;
}

interface ListingSuggestionsResponse {
  listingSuggestionsSearch?: SuggestionEntry[];
}

export interface ResolvedByAddress {
  resolved: true;
  url: string;
  listing_id: string;
  address: string;
}

export interface UnresolvedByAddress {
  resolved: false;
  error: string;
  query: string;
}

export type ByAddressResult = ResolvedByAddress | UnresolvedByAddress;

function joinNonEmpty(parts: Array<string | undefined>, sep = ' '): string {
  return parts.map((p) => (p ?? '').trim()).filter((p) => p.length > 0).join(sep);
}

export function buildAddressQuery(args: {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
}): string {
  return joinNonEmpty([args.address, args.city, args.state, args.zip], ', ');
}

function formatAddress(s: SuggestionEntry, fallback: string): string {
  const street = joinNonEmpty([
    s.streetNumber,
    s.streetDirPrefix,
    s.streetName,
    s.streetSuffix,
    s.streetDirSuffix,
    s.unitNumber ? `#${s.unitNumber}` : undefined,
  ]);
  const cityState = joinNonEmpty([s.city ?? s.postalCity, s.stateOrProvince], ', ');
  const addr = joinNonEmpty([street, cityState, s.postalCode], ', ');
  return addr || fallback;
}

export function registerByAddressTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_get_by_address',
    {
      title: 'Resolve a OneHome listing by street address',
      description:
        "Resolve a free-text street address (with optional city/state/zip) to a OneHome listing's canonical portal URL and id in one call. Fires a single `ListingSuggestionsSearch` GraphQL query, takes the top match, and returns `{ url, listing_id, address, resolved }`. When no listing matches, returns `{ resolved: false, error: \"no listing found\" }` rather than throwing — supports graceful degradation by an umbrella caller that fans out across multiple per-site resolvers. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Resolve a OneHome listing by street address',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
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
        group_id: z
          .string()
          .optional()
          .describe(
            'Optional OneHome group id to scope the suggestion search. Defaults to the magic-link session context when present.'
          ),
      },
    },
    async (input) => {
      const query = buildAddressQuery(input);
      const ctx = client.bridgeStatus().sessionContext;
      const groupId = input.group_id ?? ctx.groupId;
      const data = await client.graphql<ListingSuggestionsResponse>(
        buildListingSuggestionsSearch({
          browseParameter: query,
          groupId,
        })
      );
      const top = (data.listingSuggestionsSearch ?? []).find(
        (s) => s?.id ?? s?.listingId
      );
      if (!top) {
        const result: UnresolvedByAddress = {
          resolved: false,
          error: 'no listing found',
          query,
        };
        return textResult(result);
      }
      const listingId = (top.id ?? top.listingId) as string;
      const result: ResolvedByAddress = {
        resolved: true,
        url: buildPropertyUrl(listingId),
        listing_id: listingId,
        address: formatAddress(top, query),
      };
      return textResult(result);
    }
  );
}
