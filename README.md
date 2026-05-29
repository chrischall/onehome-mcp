# onehome-mcp

MCP server for [OneHome](https://www.onehome.com/) (CoreLogic) — search the listings your real-estate agent curated for you, fetch property details + photos, compare houses side-by-side, and run mortgage / affordability math from within Claude.

Sister project to [zillow-mcp](https://github.com/chrischall/zillow-mcp), [redfin-mcp](https://github.com/chrischall/redfin-mcp), [compass-mcp](https://github.com/chrischall/compass-mcp), and [homes-mcp](https://github.com/chrischall/homes-mcp). Same tool ergonomics — different upstream auth model.

> This project was developed and is maintained by AI (Claude). Use at your own discretion.

## What's different about OneHome

OneHome isn't a public listings site. Buyers usually reach it through a magic link an agent emails them — `https://portal.onehome.com/...?token=eyJ...`. That `token` query param IS the per-user bearer that the portal SPA hands to every GraphQL request.

So instead of routing every fetch through your signed-in browser tab (like the other realty MCPs), `onehome-mcp` talks directly to `services.onehome.com/graphql` from Node, with `Authorization: Bearer <jwt>` attached. We support three ways to source that bearer:

| Mode | How to enable | Notes |
| --- | --- | --- |
| `env_token` | `ONEHOME_TOKEN=<jwt>` | Paste the raw bearer from devtools Network panel. Most direct. |
| `magic_link` | `ONEHOME_MAGIC_LINK=https://portal.onehome.com/...?token=...` | Paste the full URL your agent sent — we extract the `token` param. |
| `fetchproxy_capture` | (no env) + [fetchproxy extension](https://github.com/chrischall/fetchproxy) installed + signed-in `portal.onehome.com` tab | We wait for your tab to fire any GraphQL request, snapshot the Authorization header, and reuse it. |

## Tools

| Tool | What it does |
| --- | --- |
| `onehome_get_user` | Smallest auth probe — returns your OneHome profile (name, email) and the groups your agent shared. |
| `onehome_get_groups` | List the OneHome "groups" your agent has shared with you (each one a market / curated listing bucket). |
| `onehome_get_saved_search` | Fetch an agent-curated saved search by id — name, filter criteria, polygon, and the OSK listing ids that compose the share. |
| `onehome_get_saved_search_with_listings` | The "show me my saved homes" flow in one round trip — saved search plus its inflated listings. |
| `onehome_search_properties` | Listings within a group; optionally scoped to a saved search. |
| `onehome_search_suggestions` | Free-text suggestion search (address, MLS #) across all feeds. |
| `onehome_get_by_address` | Resolve a single free-text street address to a listing's portal URL + id. |
| `onehome_resolve_addresses` | Bulk-resolve up to 100 structured addresses to portal URLs + listing ids; concurrent, per-row error capture. |
| `onehome_get_property` | Full property record by listing id or portal URL. |
| `onehome_bulk_get` | Fetch up to N listings in one call — one structured row per id, per-row error capture. |
| `onehome_get_property_photos` | Full media gallery — Thumbnail / Medium / Large variants + room descriptions. |
| `onehome_compare_properties` | 2-8 listings side-by-side. Per-row error capture; calls are concurrent. |
| `onehome_get_schools` | Local-Logic primary + high schools near a lat/lng. |
| `onehome_get_walk_score` | Local-Logic walk / transit / bike / car friendliness scores. |
| `onehome_graphql` | Power-user escape hatch — send a raw GraphQL document with variables. |
| `onehome_calculate_mortgage` | Local PITI calculator. Same math as the other realty MCPs. |
| `onehome_calculate_affordability` | Local 28/36 DTI solver — max home price you can afford. |
| `onehome_set_auth` | Add another authenticated session at runtime (magic link / JWT / email-token) for buyers holding shares across multiple agents. |
| `onehome_set_active_session` | Force a specific registered session to be the active one (overrides MLS-suffix routing). |
| `onehome_get_session_context` | List every registered session — auth mode, token expiry, and the group / saved-search / agent scope each bootstrapped. |
| `onehome_healthcheck` | End-to-end auth + GraphQL smoke check with token-expiry diagnostics. |

## Install

The simplest path is the published Claude plugin (`.mcpb` install). For local dev:

```bash
git clone https://github.com/chrischall/onehome-mcp
cd onehome-mcp
npm install
npm run build
```

Then point your MCP host at `node /abs/path/to/onehome-mcp/dist/bundle.js` with one of:

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "onehome-mcp": {
      "command": "node",
      "args": ["/abs/path/to/onehome-mcp/dist/bundle.js"],
      "env": {
        "ONEHOME_MAGIC_LINK": "https://portal.onehome.com/en-US/properties/map?token=eyJ..."
      }
    }
  }
}
```

## Development

```bash
npm test               # vitest, mocked transport, no network
npm run test:watch
npm run test:coverage
npx tsc --noEmit
npm run build          # tsc --noEmit + esbuild → dist/bundle.js
```

Tests use a `FakeTransport` (in `tests/helpers.ts`) that registers per-`operationName` handlers — there's no live network in the test suite. The `tests/index.test.ts` smoke check loads the same tool registrations `src/index.ts` uses against an in-memory MCP client/server pair, so "I wrote the tool file but forgot to wire it up" mistakes fail loudly.

## License

MIT.
