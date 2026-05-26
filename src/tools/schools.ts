import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';

/**
 * LocalLogic schools + walk-score live on REST endpoints under
 * `services.onehome.com/api/locallogic/...`. The portal bundle wraps
 * these in GraphQL `@rest` directives — that's a CLIENT-side Apollo
 * rewrite; the GraphQL endpoint itself doesn't understand them.
 *
 * Both endpoints take query-string `lat`, `lng`, `locale` and return
 * `{ data: { ... } }` JSON. The schools endpoint is often 403 for
 * consumer-share sessions (agent-only data); the walk-score endpoint
 * works for consumers and returns school proximity as a derived
 * `value`/`text` summary so callers can still surface a high-level
 * answer.
 */

interface RawScore {
  value?: string;
  text?: string;
}

interface RawScoresLocation {
  high_schools?: RawScore;
  primary_schools?: RawScore;
  groceries?: RawScore;
  restaurants?: RawScore;
  pedestrian_friendly?: RawScore;
  car_friendly?: RawScore;
  cycling_friendly?: RawScore;
  transit_friendly?: RawScore;
  cafes?: RawScore;
  daycares?: RawScore;
  parks?: RawScore;
  shopping?: RawScore;
}

interface ScoresResponse {
  data?: {
    type?: string;
    location?: RawScoresLocation;
  };
}

interface SchoolEntry {
  name?: string;
  school_attributes?: {
    types?: string[];
    grades?: string[];
    programs?: string[];
    levels?: string[];
  };
  proximity?: {
    walking?: { distance?: number };
    linear_distance?: number;
  };
}

interface SchoolsResponse {
  data?: {
    primary_schools?: SchoolEntry[];
    high_schools?: SchoolEntry[];
  };
}

function buildPath(endpoint: 'scores' | 'schools', args: {
  lat: number;
  lng: number;
  language?: string;
}): string {
  const params = new URLSearchParams({
    lat: String(args.lat),
    lng: String(args.lng),
    locale: args.language ?? 'en',
  });
  return `/locallogic/${endpoint}?${params.toString()}`;
}

export function registerSchoolsTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_get_schools',
    {
      title: 'Local-Logic primary + high schools near a lat/lng',
      description:
        'Fetch the Local-Logic school data for a coordinate — separate primary and high-school lists, each entry with name, attributes (types/grades/programs/levels), and proximity (walking distance + straight-line distance). Returns an `error` field with HTTP details if the consumer session does not have access (the schools endpoint is sometimes agent-only). lat/lng usually come from `onehome_get_property` (`latitude` / `longitude`).',
      annotations: {
        title: 'Local-Logic primary + high schools near a lat/lng',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        lat: z.number(),
        lng: z.number(),
        language: z.string().optional(),
      },
    },
    async (i) => {
      const path = buildPath('schools', i);
      const result = await client.rest<SchoolsResponse>(path);
      if (!result.ok) {
        return textResult({
          lat: i.lat,
          lng: i.lng,
          ok: false,
          status: result.status,
          error:
            result.status === 403
              ? 'OneHome blocked the schools REST endpoint for this session — the LocalLogic schools dataset is often agent-only on consumer-share accounts. Try `onehome_get_walk_score` instead; it works for consumers and includes a high-level school-proximity summary.'
              : `Local-Logic /schools returned HTTP ${result.status}: ${
                  typeof result.data === 'string'
                    ? result.data.slice(0, 200)
                    : JSON.stringify(result.data).slice(0, 200)
                }`,
        });
      }
      const root = (result.data as SchoolsResponse)?.data ?? {};
      return textResult({
        lat: i.lat,
        lng: i.lng,
        ok: true,
        primary_schools: root.primary_schools ?? [],
        high_schools: root.high_schools ?? [],
      });
    }
  );

  server.registerTool(
    'onehome_get_walk_score',
    {
      title: 'Local-Logic location scores near a lat/lng',
      description:
        'Local-Logic location scores for a coordinate — pedestrian / car / cycling / transit friendliness, plus proximity summaries for groceries, restaurants, parks, primary + high schools. Each score is a `{ value, text }` pair (value 0-5, text a one-line description). Returns an `error` field with HTTP details if the upstream rejected the request.',
      annotations: {
        title: 'Local-Logic location scores near a lat/lng',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        lat: z.number(),
        lng: z.number(),
        language: z.string().optional(),
      },
    },
    async (i) => {
      const path = buildPath('scores', i);
      const result = await client.rest<ScoresResponse>(path);
      if (!result.ok) {
        return textResult({
          lat: i.lat,
          lng: i.lng,
          ok: false,
          status: result.status,
          error: `Local-Logic /scores returned HTTP ${result.status}: ${
            typeof result.data === 'string'
              ? result.data.slice(0, 200)
              : JSON.stringify(result.data).slice(0, 200)
          }`,
        });
      }
      const root = (result.data as ScoresResponse)?.data ?? {};
      return textResult({
        lat: i.lat,
        lng: i.lng,
        ok: true,
        scores: root.location ?? {},
      });
    }
  );
}
