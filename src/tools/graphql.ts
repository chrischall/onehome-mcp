import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { OneHomeClient } from '../client.js';
import { minifiedResult } from '../mcp.js';
import { viewArg, viewResponse } from '../view.js';

/**
 * Power-user escape hatch: send a raw GraphQL document with the
 * MCP's already-bootstrapped auth.
 *
 * The structured tools (`onehome_get_user`, `onehome_search_properties`,
 * etc.) cover the common cases with curated field sets; this tool
 * exists so a knowledgeable caller can request an operation we haven't
 * wrapped, or pull additional fields we haven't yet surfaced. The whole
 * upstream response envelope (data + errors + http status) comes back —
 * unprojected, so the caller can inspect schema errors directly.
 *
 * **"Unprojected" is not the same as "untouched," and the difference is
 * this tool's default.** `view` defaults to `compact`, which strips image
 * and avatar URLs out of `data` — this is the one tool in the server whose
 * response really does carry OneHome's own media URLs, so it is the one
 * place that default removes something. `view: 'full'` returns the envelope
 * byte for byte. That matters more here than anywhere else: the reason to
 * reach for this tool is usually that a payload is not what you expected,
 * and a doc promising "verbatim" while quietly dropping fields would send a
 * caller hunting upstream for a field this server removed. Everything else
 * survives compact, including every envelope key (`errors`, `status`,
 * `url`) and any non-media field of `data`.
 */

/**
 * The operation keyword of every top-level definition in a GraphQL
 * document (`query`, `mutation`, `subscription`, `fragment`; a shorthand
 * `{ … }` counts as `query`). A deliberately small lexer rather than a
 * `graphql` dependency: strings, block strings and comments are blanked
 * first so their contents can't be mistaken for keywords, then only the
 * first word of each brace/paren-depth-0 definition is read.
 */
export function topLevelOperationKinds(document: string): string[] {
  const src = document.replace(
    /"""(?:\\"""|[\s\S])*?"""|"(?:\\.|[^"\\\n])*"|#[^\n\r]*/g,
    ' '
  );
  const kinds: string[] = [];
  let depth = 0;
  let expectingDefinition = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '{' || c === '(' || c === '[') {
      if (depth === 0 && expectingDefinition && c === '{') {
        kinds.push('query');
        expectingDefinition = false;
      }
      depth++;
    } else if (c === '}' || c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && c === '}') expectingDefinition = true;
    } else if (depth === 0 && expectingDefinition && /[_A-Za-z]/.test(c)) {
      const word = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i))![0];
      kinds.push(word);
      expectingDefinition = false;
      i += word.length - 1;
    }
  }
  return kinds;
}

const WRITE_OPERATIONS = new Set(['mutation', 'subscription']);

export function registerGraphqlTool(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_graphql',
    {
      title: 'Send a raw GraphQL document to services.onehome.com',
      description:
        "Power-user escape hatch — send a raw GraphQL document with variables. Returns the whole `{ data, errors, status, url }` envelope, unprojected, so you can read upstream schema errors directly. Note the default: `view` is `compact`, which strips image/avatar URLs out of `data` (every envelope key and every non-media field is kept). Pass `view: 'full'` when you need the envelope byte for byte — worth doing if you are here because a payload is not what you expected, so a missing field is never this server's doing. Operation names live in the portal bundle; common ones include `GetOneHomeUser`, `GetListings`, `GetPins`, `ListingById`, `MediaListingById`, `GetSavedSearches`, `ListingSuggestionsSearch`. (LocalLogic schools/walk-score are REST endpoints, not GraphQL operations — use `onehome_get_schools` / `onehome_get_walk_score`.) Pass `query` (the full document body), an `operation_name` matching the document, and any `variables` as JSON. Read-only: documents containing a `mutation` or `subscription` operation are refused.",
      annotations: {
        title: 'Send a raw GraphQL document to services.onehome.com',
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        operation_name: z.string(),
        query: z.string(),
        variables: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async (i) => {
      const write = topLevelOperationKinds(i.query).find((k) =>
        WRITE_OPERATIONS.has(k)
      );
      if (write) {
        throw new Error(
          `onehome_graphql is read-only: the document contains a \`${write}\` ` +
            'operation, which is refused so this tool never changes portal state ' +
            '(favorites, saved searches, profile). Send only `query` operations.'
        );
      }
      const result = await client.graphqlRaw({
        operationName: i.operation_name,
        query: i.query,
        variables: i.variables ?? {},
      });
      return viewResponse((i as { view?: string }).view, result);
    }
  );
}
