// Smoke test for the full tool surface. Catches "registered the tool
// file but forgot to wire it up in index.ts" mistakes the per-tool
// suites miss.
import { describe, it, expect, afterAll } from 'vitest';
import { OneHomeClient } from '../src/client.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerSavedTools } from '../src/tools/saved.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerPropertyTools } from '../src/tools/properties.js';
import { registerPhotosTools } from '../src/tools/photos.js';
import { registerCompareTools } from '../src/tools/compare.js';
import { registerSchoolsTools } from '../src/tools/schools.js';
import { registerGraphqlTool } from '../src/tools/graphql.js';
import { registerMortgageTools } from '../src/tools/mortgage.js';
import { registerAffordabilityTools } from '../src/tools/affordability.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { FakeTransport, createTestHarness } from './helpers.js';

const EXPECTED_TOOLS = [
  'onehome_get_user',
  'onehome_get_groups',
  'onehome_get_session_context',
  'onehome_get_saved_search',
  'onehome_search_properties',
  'onehome_search_suggestions',
  'onehome_get_property',
  'onehome_get_property_photos',
  'onehome_compare_properties',
  'onehome_get_schools',
  'onehome_get_walk_score',
  'onehome_graphql',
  'onehome_calculate_mortgage',
  'onehome_calculate_affordability',
  'onehome_healthcheck',
];

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('tool registration', () => {
  it('registers every advertised onehome_* tool', async () => {
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) => {
      registerUserTools(server, client);
      registerSavedTools(server, client);
      registerSearchTools(server, client);
      registerPropertyTools(server, client);
      registerPhotosTools(server, client);
      registerCompareTools(server, client);
      registerSchoolsTools(server, client);
      registerGraphqlTool(server, client);
      registerMortgageTools(server);
      registerAffordabilityTools(server);
      registerHealthcheckTools(server, client);
    });
    const tools = await harness.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });
});
