import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import { buildGetSavedSearchBySearchId } from '../queries.js';

export interface UserQueryEntry {
  fieldName?: string;
  type?: string;
  values?: string[];
}

export interface PolygonPoint {
  latitude?: number;
  longitude?: number;
}

export interface RawSavedSearch {
  id?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  setType?: string;
  listingIds?: string[];
  isActive?: boolean;
  resourceID?: string;
  userQuery?: UserQueryEntry[];
  polygon?: PolygonPoint[];
}

export interface FormattedSavedSearch {
  saved_search_id?: string;
  name?: string;
  set_type?: string;
  is_active?: boolean;
  resource_id?: string;
  created_at?: string;
  updated_at?: string;
  listing_count?: number;
  listing_ids?: string[];
  /** User-set filter criteria, flattened as an array of {field, type, values}. */
  filters?: Array<{ field: string; type?: string; values?: string[] }>;
  /** Geographic polygon (`{latitude, longitude}` vertices) — present when the agent drew an area. */
  polygon?: PolygonPoint[];
}

export function formatSavedSearch(
  raw: RawSavedSearch,
  opts: { include_listing_ids?: boolean } = {}
): FormattedSavedSearch {
  const out: FormattedSavedSearch = {};
  if (raw.id) out.saved_search_id = raw.id;
  if (raw.name) out.name = raw.name;
  if (raw.setType) out.set_type = raw.setType;
  if (typeof raw.isActive === 'boolean') out.is_active = raw.isActive;
  if (raw.resourceID) out.resource_id = raw.resourceID;
  if (raw.createdAt) out.created_at = raw.createdAt;
  if (raw.updatedAt) out.updated_at = raw.updatedAt;
  const ids = raw.listingIds ?? [];
  out.listing_count = ids.length;
  if (opts.include_listing_ids) out.listing_ids = ids;
  if (raw.userQuery && raw.userQuery.length > 0) {
    out.filters = raw.userQuery
      .filter((q) => q.fieldName !== undefined)
      .map((q) => ({
        field: q.fieldName!,
        ...(q.type !== undefined ? { type: q.type } : {}),
        ...(q.values !== undefined ? { values: q.values } : {}),
      }));
  }
  if (raw.polygon && raw.polygon.length > 0) out.polygon = raw.polygon;
  return out;
}

export function registerSavedTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_get_saved_search',
    {
      title: 'Fetch a OneHome saved search by id',
      description:
        "Fetch the agent-curated saved search by its id (UUID). Returns the search's name, filter criteria (`filters[]`), polygon, listing count, and the full list of OSK listing ids that compose the consumer share (`listing_ids`). Pass `include_listing_ids: false` to suppress the listing-id array if you only need the metadata. This is the canonical consumer-readable endpoint; the by-groupId variant is agent-only. `saved_search_id` defaults to the MCP's session context when omitted.",
      annotations: {
        title: 'Fetch a OneHome saved search by id',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        saved_search_id: z.string().optional(),
        include_listing_ids: z.boolean().optional(),
      },
    },
    async (i) => {
      const id =
        i.saved_search_id ??
        client.bridgeStatus().sessionContext.savedSearchId;
      if (!id) {
        throw new Error(
          'onehome_get_saved_search: no saved_search_id supplied and the ' +
            'MCP did not bootstrap one from the magic-link context. Pass ' +
            'one explicitly, or run with ONEHOME_MAGIC_LINK so the MCP can ' +
            'derive a default from the checkToken response.'
        );
      }
      const data = await client.graphql<{ savedSearch?: RawSavedSearch }>(
        buildGetSavedSearchBySearchId(id)
      );
      if (!data.savedSearch) {
        throw new Error(
          `onehome_get_saved_search: saved search ${id} not found or not ` +
            'accessible with the current session token.'
        );
      }
      return textResult(
        formatSavedSearch(data.savedSearch, {
          include_listing_ids: i.include_listing_ids ?? true,
        })
      );
    }
  );
}
