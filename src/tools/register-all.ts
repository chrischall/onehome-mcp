import type { ToolRegistrar } from '@chrischall/mcp-utils';
import type { OneHomeClient } from '../client.js';
import { registerUserTools } from './user.js';
import { registerSavedTools } from './saved.js';
import { registerSavedWithListingsTools } from './saved-with-listings.js';
import { registerSearchTools } from './search.js';
import { registerPropertyTools } from './properties.js';
import { registerPhotosTools } from './photos.js';
import { registerCompareTools } from './compare.js';
import { registerBulkGetTools } from './bulk-get.js';
import { registerSchoolsTools } from './schools.js';
import { registerGraphqlTool } from './graphql.js';
import { registerMortgageTools } from './mortgage.js';
import { registerAffordabilityTools } from './affordability.js';
import { registerHealthcheckTools } from './healthcheck.js';
import { registerByAddressTools } from './by-address.js';
import { registerResolveAddressesTools } from './resolve-addresses.js';
import { registerAuthTools } from './auth.js';

/**
 * Every tool registrar the server wires up, in registration order. The
 * single source for `index.ts` and for the test that keeps
 * `manifest.json`'s `tools[]` in sync with what is actually registered.
 */
export const TOOL_REGISTRARS: ToolRegistrar<OneHomeClient>[] = [
  registerUserTools,
  registerSavedTools,
  registerSavedWithListingsTools,
  registerSearchTools,
  registerPropertyTools,
  registerPhotosTools,
  registerCompareTools,
  registerBulkGetTools,
  registerSchoolsTools,
  registerGraphqlTool,
  (server) => registerMortgageTools(server),
  (server) => registerAffordabilityTools(server),
  registerHealthcheckTools,
  registerByAddressTools,
  registerResolveAddressesTools,
  registerAuthTools,
];
