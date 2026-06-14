#!/usr/bin/env node
// onehome-mcp entrypoint.
//
// OneHome (CoreLogic) uses bearer-token auth, not session cookies —
// so the auth model is different from the other realty MCPs
// (compass / homes / redfin). We support three sources, tried in
// order:
//
//   1. `ONEHOME_TOKEN` (env): raw bearer JWT.
//   2. `ONEHOME_MAGIC_LINK` (env): full portal URL with `?token=...`.
//      We extract the token param and use it as the bearer.
//   3. fetchproxy `captureRequestHeader`: stand up a WebSocket bridge
//      on 127.0.0.1:37149 and wait for the user's signed-in
//      portal.onehome.com Chrome tab to fire a GraphQL request —
//      we snapshot its Authorization header.
//
// All three resolve to "we have a bearer", at which point every tool
// calls services.onehome.com/graphql directly from Node with that
// bearer attached. There's no Pattern-A "every call rides the user's
// tab" routing here because OneHome's GraphQL endpoint is a real
// JSON API that accepts direct connections — once auth is sorted
// there's no anti-bot challenge to dodge.

import { runMcp, readEnvVar, loadDotenvSafely } from '@chrischall/mcp-utils';
import { OneHomeClient } from './client.js';
import { tryBuildDirectTransportFromEnv } from './transport-direct.js';
import { FetchproxyTransport } from './transport-fetchproxy.js';
import { registerUserTools } from './tools/user.js';
import { registerSavedTools } from './tools/saved.js';
import { registerSavedWithListingsTools } from './tools/saved-with-listings.js';
import { registerSearchTools } from './tools/search.js';
import { registerPropertyTools } from './tools/properties.js';
import { registerPhotosTools } from './tools/photos.js';
import { registerCompareTools } from './tools/compare.js';
import { registerBulkGetTools } from './tools/bulk-get.js';
import { registerSchoolsTools } from './tools/schools.js';
import { registerGraphqlTool } from './tools/graphql.js';
import { registerMortgageTools } from './tools/mortgage.js';
import { registerAffordabilityTools } from './tools/affordability.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerByAddressTools } from './tools/by-address.js';
import { registerResolveAddressesTools } from './tools/resolve-addresses.js';
import { registerAuthTools } from './tools/auth.js';
import type { OneHomeTransport } from './transport.js';

const VERSION = '0.12.4'; // x-release-please-version

// Local-dev convenience: load a `.env` if present. No-op (and never throws)
// inside an mcpb bundle where creds arrive via the host's mcp_config.env.
await loadDotenvSafely();

const wsPort = readEnvVar('ONEHOME_WS_PORT');
const port = wsPort ? Number(wsPort) : undefined;

const direct = tryBuildDirectTransportFromEnv(process.env);
let transport: OneHomeTransport;
let mode: 'env_token' | 'magic_link' | 'fetchproxy_capture';
if (direct) {
  transport = direct.transport;
  mode = direct.authMode;
} else {
  transport = new FetchproxyTransport({ port, version: VERSION });
  mode = 'fetchproxy_capture';
}

const client = new OneHomeClient({ transport });
try {
  await client.start();
} catch (err) {
  // If `start()` fails (e.g. checkToken exchange rejected the email
  // token), log the reason but keep the process up so the host's
  // initial `tools/list` can still complete. The first tool call will
  // surface the same error.
  console.error(
    `[onehome-mcp] startup bootstrap failed (continuing in degraded mode): ${
      err instanceof Error ? err.message : String(err)
    }`
  );
}

const modeBanner = {
  env_token: 'auth: ONEHOME_TOKEN (direct bearer)',
  magic_link: 'auth: ONEHOME_MAGIC_LINK (direct bearer extracted from URL)',
  fetchproxy_capture: `auth: fetchproxy capture (waiting on a signed-in portal.onehome.com tab on port ${
    port ?? 37149
  })`,
}[mode];

await runMcp({
  name: 'onehome-mcp',
  version: VERSION,
  deps: client,
  tools: [
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
  ],
  banner:
    `[onehome-mcp] v${VERSION} — ${modeBanner}. ` +
    'This project was developed and is maintained by AI (Claude). ' +
    'Use at your own discretion.',
  shutdown: { onSignal: () => client.close() },
});
