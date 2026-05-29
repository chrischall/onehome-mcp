import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';

/**
 * Power-user escape hatch: send a raw GraphQL document with the
 * MCP's already-bootstrapped auth.
 *
 * The structured tools (`onehome_get_user`, `onehome_search_properties`,
 * etc.) cover the common cases with curated field sets; this tool
 * exists so a knowledgeable caller can request an operation we haven't
 * wrapped, or pull additional fields we haven't yet surfaced. The full
 * upstream response envelope (data + errors + http status) is returned
 * verbatim so the caller can inspect schema errors directly.
 */

export function registerGraphqlTool(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_graphql',
    {
      title: 'Send a raw GraphQL document to services.onehome.com',
      description:
        "Power-user escape hatch — send a raw GraphQL document with variables. Returns the full `{ data, errors, status, url }` envelope so you can read upstream schema errors directly. Operation names live in the portal bundle; common ones include `GetOneHomeUser`, `GetListings`, `GetPins`, `ListingById`, `MediaListingById`, `GetSavedSearches`, `ListingSuggestionsSearch`. (LocalLogic schools/walk-score are REST endpoints, not GraphQL operations — use `onehome_get_schools` / `onehome_get_walk_score`.) Pass `query` (the full document body), an `operation_name` matching the document, and any `variables` as JSON.",
      annotations: {
        title: 'Send a raw GraphQL document to services.onehome.com',
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        operation_name: z.string(),
        query: z.string(),
        variables: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (i) => {
      const result = await client.graphqlRaw({
        operationName: i.operation_name,
        query: i.query,
        variables: i.variables ?? {},
      });
      return textResult(result);
    }
  );
}
