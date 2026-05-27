# CLAUDE.md — onehome-mcp

Guidance for Claude working in this repo.

## TL;DR

v0.6.0: OneHome (CoreLogic) MCP server. OneHome isn't a public realty site — buyers reach it through a private "magic link" their real-estate agent emails (`https://portal.onehome.com/...?token=eyJ...`). The portal is an Angular SPA backed by `services.onehome.com/graphql` (real GraphQL) plus a few `services.onehome.com/api/...` REST endpoints (LocalLogic schools/scores, the token-exchange bootstrap). All authenticated requests go through `Authorization: Bearer <sessionToken>`.

So onehome-mcp departs from the Pattern A / Pattern B fetchproxy split the other realty MCPs use. Every tool call is a **direct Node fetch to `services.onehome.com`** with an `Authorization: Bearer <sessionToken>` header attached. The interesting parts are *where the bearer comes from* and *the email-token → sessionToken bootstrap*:

1. `ONEHOME_TOKEN` — raw bearer pasted from devtools. If it's a 3-segment JWT we use it directly; if it's a 1-segment base64 blob (the URL `?token=...` shape) we exchange it (#2 below).
2. `ONEHOME_MAGIC_LINK` — the full portal URL with `?token=...`. We extract the `token` query param, recognize it as an email-token (single base64 segment carrying `{ OSN, contactid, agentid, setid, … }`), and POST it to `POST /api/authentication/checkToken { emailToken }` to get back a real sessionToken JWT — plus the consumer's group / savedSearch / agent scope, which the MCP caches and uses to default unspecified `group_id` / `saved_search_id` arguments.
3. fetchproxy `captureRequestHeader` — bring up a `@fetchproxy/server` bridge on 127.0.0.1:37149 and wait for the user's signed-in `portal.onehome.com` Chrome tab to fire any GraphQL request; snapshot its Authorization header (which is already a `Bearer <sessionToken>` post-exchange), cache it, then make direct outbound calls from Node.

Once the bearer is acquired we don't route subsequent calls through fetchproxy — there's no anti-bot challenge to dodge at `services.onehome.com`, so the round-trip through the tab would just add latency and a bridge-down failure mode.

## Tool surface

| Tool | File | Upstream | Auth |
| --- | --- | --- | --- |
| `onehome_get_user` | `tools/user.ts` | `GetOneHomeUser` for agent sessions; falls back to checkToken session context for consumer sessions (the GraphQL `user` field is agent-only) | yes |
| `onehome_get_groups` | `tools/user.ts` | Same — GraphQL `user.groups` for agents, synthesizes a one-entry list from session context for consumer-shares | yes |
| `onehome_get_session_context` | `tools/user.ts` | (local — reflects `client.bridgeStatus().sessionContext`) | no |
| `onehome_get_saved_search` | `tools/saved.ts` | `GetSavedSearchBySearchId` (consumer-readable; the by-groupId variant is agent-only) | yes |
| `onehome_search_properties` | `tools/search.ts` | With `saved_search_id`: `GetSavedSearchBySearchId` → resolves `listingIds`, then `GetSavedListings (listingsBySavedSearchId)`. Without: `GetListings` | yes |
| `onehome_search_suggestions` | `tools/search.ts` | `ListingSuggestionsSearch` | yes |
| `onehome_get_property` | `tools/properties.ts` | `ListingById` | yes |
| `onehome_get_property_photos` | `tools/photos.ts` | `MediaListingById` | yes |
| `onehome_compare_properties` | `tools/compare.ts` | Concurrent `ListingById` calls | yes |
| `onehome_get_schools` | `tools/schools.ts` | REST `GET /api/locallogic/schools?lat=&lng=&locale=` (often 403 for consumer sessions — surfaces a clean error) | yes |
| `onehome_get_walk_score` | `tools/schools.ts` | REST `GET /api/locallogic/scores?lat=&lng=&locale=` (works for consumers — also returns school-proximity summaries) | yes |
| `onehome_graphql` | `tools/graphql.ts` | arbitrary (user supplies the document) | yes |
| `onehome_calculate_mortgage` | `tools/mortgage.ts` | — | no (local) |
| `onehome_calculate_affordability` | `tools/affordability.ts` | — | no (local) |
| `onehome_healthcheck` | `tools/healthcheck.ts` | `GetSavedSearchBySearchId` when session context has one; else `GetOneHomeUser` | yes |
| `onehome_set_auth` | `tools/auth.ts` | (local — `parseAuthInput` → new `DirectTransport` → POST `/api/authentication/checkToken` if email-token) | no (it's how you *acquire* auth) |

## Architecture

```
src/
  index.ts              # entry — pick DirectTransport (env) or
                        #   FetchproxyTransport (capture), build client,
                        #   register tools, stdio loop.
  transport.ts          # OneHomeTransport interface (graphql + rest primitives).
  transport-direct.ts   # node-fetch → services.onehome.com with Bearer.
                        #   On start() exchanges email-token → sessionToken
                        #   via /api/authentication/checkToken when needed.
  transport-fetchproxy.ts # captureRequestHeader bootstrap → direct outbound.
  auth.ts               # parseJwt, isJwtShape, extractTokenFromMagicLink,
                        #   exchangeEmailToken + typed errors.
  client.ts             # OneHomeClient: unwraps `data` / throws on `errors`;
                        #   .rest() for the LocalLogic endpoints.
  queries.ts            # canonical GraphQL documents — field shapes mirror
                        #   the actual portal bundle fragments (User: `id`
                        #   not `userId`; SavedSearch: `listingIds` /
                        #   `userQuery` / `polygon`; BrowseParameter:
                        #   `pageInput { pageNum, size }`).
  format.ts             # RawListingDetail → FormattedListing flattening.
  url.ts                # listing-id (OSK) extraction from URL/path/raw.
  mcp.ts                # textResult() wrapper.
  tools/
    user.ts             # onehome_get_user, onehome_get_groups,
                        #   onehome_get_session_context. Both `user` /
                        #   `groups` fall back to session context when the
                        #   GraphQL `user { }` field is access-denied
                        #   (consumer-share sessions).
    saved.ts            # onehome_get_saved_search (GetSavedSearchBySearchId).
    search.ts           # onehome_search_properties — with `saved_search_id`,
                        #   resolves SavedSearch.listingIds first then inflates
                        #   via listingsBySavedSearchId; without, falls back to
                        #   the raw listings(groupId, browseParameter) form.
                        #   Plus onehome_search_suggestions.
    properties.ts       # onehome_get_property (ListingById + format).
    photos.ts           # onehome_get_property_photos (MediaListingById).
    compare.ts          # onehome_compare_properties (concurrent
                        #   ListingById, per-row error capture).
    schools.ts          # onehome_get_schools + onehome_get_walk_score —
                        #   REST calls via OneHomeClient.rest(), not GraphQL.
                        #   Schools often 403 for consumer sessions; the
                        #   tool surfaces it with a hint to use walk_score.
    graphql.ts          # onehome_graphql escape hatch (raw document).
    mortgage.ts         # local PITI calculator.
    affordability.ts    # local 28/36 DTI solver.
    healthcheck.ts      # picks GetSavedSearchBySearchId or GetOneHomeUser
                        #   depending on what the session can reach.

tests/                  # Mirror of src/, plus tests/helpers.ts harness.
                        #   FakeTransport stubs graphql() per operation
                        #   and rest() per path prefix; createTestHarness()
                        #   wires up an in-memory Client/Server pair so
                        #   tools are exercised through the actual SDK
                        #   request path.
```

Each `tools/*.ts` file exports `registerXxxTools(server, client)` (or `(server)` for the local-only tools); `src/index.ts` calls all of them.

## Commands

```bash
npm run build          # tsc --noEmit + esbuild bundle → dist/bundle.js
npm test               # vitest, mocked transport, no network
npm run test:watch
npm run test:coverage  # v8 coverage, no thresholds
npx tsc --noEmit       # typecheck only
node dist/bundle.js    # launch the MCP server over stdio
```

## Environment

Auth source (at least one of):

```
ONEHOME_TOKEN=eyJ...                          # raw bearer JWT (preferred)
ONEHOME_MAGIC_LINK=https://portal.onehome.com/en-US/properties/map?token=eyJ...
```

Or omit both and let the MCP capture the bearer from a signed-in `portal.onehome.com` tab via the fetchproxy extension. The extension is installed separately (see https://github.com/chrischall/fetchproxy).

Optional:

```
ONEHOME_WS_PORT=37149   # override the fetchproxy WebSocket port (capture mode only)
```

## Conventions

- All tools prefixed `onehome_*`.
- Tool return shape: `textResult(data)` from `src/mcp.ts` → `{ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }`. Don't hand-roll the wrapper.
- Tool annotations: every tool sets `title`, `readOnlyHint: true`, `idempotentHint: true`, and `openWorldHint`. The last is `true` for GraphQL-bound tools and `false` for `onehome_calculate_mortgage` / `onehome_calculate_affordability` (pure local computation). `onehome_graphql` sets `idempotentHint: false` because the document may be a mutation.
- `OneHomeClient.graphql<T>(req)` unwraps `data` and throws on `errors`. For raw envelope access (`onehome_graphql`), use `OneHomeClient.graphqlRaw(req)`.
- Path-only inputs in queries: tool authors hand `OneHomeClient.graphql` a `{operationName, query, variables}` request — never an inline URL. URLs are built once in the transports.
- Tests must mock through `FakeTransport.on(operationName, handler)`. Direct fetch mocking is allowed only in `transport-direct.test.ts`.
- Write a failing test before implementation (TDD).
- ESM + NodeNext: imports use `.js` extensions even for `.ts` source.
- stdio transport: log warnings/banners to **stderr** only — stdout is reserved for JSON-RPC.

## OneHome quirks

- **The URL `?token=…` is NOT a bearer.** It's an *email-token* — a single-segment base64 blob containing `{ OSN, contactid, agentid, setid, setkey, email, ViewMode }`. The bundle posts it to `POST /api/authentication/checkToken { emailToken }`, which returns the real session-token bearer (a 3-segment JWT, ~800 chars) **plus** the consumer's session scope (`groupID`, `savedSearchID`, `agentID`, `contactID`, `mlsID`). The MCP does this exchange on `start()` for `magic_link` mode and any `env_token` value that lacks JWT shape.
- **`sessionContext` defaults.** The IDs we get back from checkToken are surfaced through `client.bridgeStatus().sessionContext`. Every tool that takes `group_id` / `saved_search_id` defaults it from there, so the one-share consumer workflow needs zero arguments. `onehome_get_session_context` is the diagnostic tool that prints whatever the MCP bootstrapped.
- **Two hostnames.** `portal.onehome.com` is the Angular SPA. `services.onehome.com` is the API host (GraphQL at `/graphql`, REST at `/api/...`). CORS allows portal→services; direct Node fetches set `Origin: https://portal.onehome.com`.
- **Consumer vs agent access split.** Many GraphQL fields are agent-only. `user { ... }`, `savedSearchByGroupId`, and `/api/locallogic/schools` all return Access Denied / HTTP 403 for consumer-share sessions. Consumer-friendly equivalents: `GetSavedSearchBySearchId`, `listingsBySavedSearchId`, the session context fields, and `/api/locallogic/scores`. `onehome_get_user` / `onehome_get_groups` / `onehome_healthcheck` all detect the consumer case and fall back automatically.
- **Listings are scoped by group + saved search.** The standard "view 30 homes my agent picked" path is: `GetSavedSearchBySearchId(searchId)` → `savedSearch.listingIds[]` → `GetSavedListings(groupId, osks: listingIds, savedSearchId)`. `onehome_search_properties` does both steps automatically when `saved_search_id` is set; without it, falls back to the raw `listings(groupId, browseParameter)` endpoint (often returns 0 for consumer accounts — they only have the saved-search view).
- **BrowseParameter shape.** Not `{ pageNumber, pageSize }`. The real shape is `{ searchQuery, sort: { name, order }, pageInput: { pageNum, size } }`. SortCriteria's `name` is a dotted GraphQL path; `property.MajorChangeTimestamp DESC` is "Newest".
- **Free-text search bypasses groups.** `ListingSuggestionsSearch` accepts a free-form `browseParameter` string and returns matches across all MLS feeds the consumer can see. Useful for MLS-number / address lookups.
- **SavedSearch shape.** Real fields: `id`, `name`, `setType`, `listingIds`, `userQuery[]` (structured `{fieldName, type, values}` — not a JSON string), `polygon`, `isActive`, `resourceID`, `createdAt`, `updatedAt`. Earlier scaffolding assumed `savedSearchId` / `isPrimary` / `searchCriteria` — those don't exist.
- **Listing IDs are OSKs.** OneHome's stable id is the OSK ("Origin System Key") — a 20-60 char alphanumeric token like `EYxOzZSAbCdEf12345`. We accept the bare id, `/en-US/properties/<id>`, or any portal URL containing one.
- **Media variants.** Each photo carries `Thumbnail` (~320px), `Medium` (~800px), and `Large` (~1600px) variants — we prefer `Large` for `primary_photo_url` and fall back as needed. `LongDescription` is the room caption ("Living room facing the lake").
- **LocalLogic is REST, not GraphQL.** The portal bundle wraps schools / walk-score queries in Apollo's `@rest` directive — that's a *client-side* Apollo construct. POSTing those documents to `/graphql` fails with `UnknownDirective 'rest'`. The actual URLs are `GET /api/locallogic/schools?lat=&lng=&locale=` and `GET /api/locallogic/scores?lat=&lng=&locale=`. Both are reached via `OneHomeClient.rest()` (a separate transport primitive alongside `graphql()`).
- **The portal app sets `Authorization` via an Angular interceptor.** This is why a raw fetch from a `portal.onehome.com` tab through fetchproxy *doesn't* auto-attach the bearer — fetchproxy bypasses Angular's HttpClient. We work around this by capturing the header from the user's organic page activity (`captureRequestHeader`), not by re-routing every call.

## Publishing constraints

The MCP Registry's [server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) caps `server.json`'s `description` at **100 characters**. Values over that fail `mcp-publisher publish` with HTTP 422 (`validation failed: expected length <= 100, location: body.description`). The other description fields (`manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) have no published length constraint and can stay longer.

Sanity-check before committing a description change:

```bash
jq -r '.description | length' server.json
```

## Versioning

Version appears in SEVEN places — all must match. `release-please-config.json` registers them as `extra-files` and bumps them in one PR per release:

1. `package.json` → `"version"`
2. `package-lock.json` → kept in sync by `npm install --package-lock-only`
3. `src/index.ts` → `VERSION` const (annotated with `// x-release-please-version`) + startup banner
4. `manifest.json` → `"version"`
5. `server.json` → `"version"` and `packages[].version`
6. `.claude-plugin/plugin.json` → `"version"`
7. `.claude-plugin/marketplace.json` → `metadata.version` + `plugins[].version`

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. release-please owns versioning.

## Pull requests & release notes

**Default workflow: branch + PR, even for solo work.** Direct pushes to `main` skip review *and* the auto-generated release notes block (configured in `.github/release.yml`).

For every PR, apply exactly one label:

| Label                  | Section in release notes |
|------------------------|--------------------------|
| `enhancement`          | Features                 |
| `bug`                  | Bug Fixes                |
| `security`             | Security                 |
| `refactor`             | Refactor                 |
| `documentation`        | Documentation            |
| `test`                 | Tests                    |
| `dependencies`         | Dependencies             |
| `ci` / `github_actions`| CI & Build               |
| *(none / unmatched)*   | Other Changes            |
| `ignore-for-release`   | Hidden from notes        |

**Exception for first-party dependency bumps.** When bumping a package we own (currently `@fetchproxy/server` — anything published from a chrischall-owned repo), label the PR `enhancement` or `bug` instead of `dependencies`, and use the matching commit prefix (`feat:` or `fix:`) instead of `chore:`. Those bumps deliver real product fixes or features through us, so they should drive a release-please version bump and show up under Features/Bug Fixes in the release notes — not get hidden under "Dependencies" (which doesn't trigger a release).

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation does it:

1. `pr-auto-review.yml` runs a Claude review on every PR **except** the release-please release PR (which it deliberately skips). On a `pass` verdict it adds the `ready-to-merge` label.
2. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash`. The moment CI is green the PR squash-merges itself.

For ordinary feature/fix PRs, opening with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line) is the whole job. If Claude's verdict was `warn`/`fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`.

### PR timing — only open when the feature is done

Because PRs auto-merge as soon as auto-review passes, **do not open a PR until the feature is genuinely complete**. There's no draft-PR safety net here:

- Don't open a PR to "stage" work while live verification, follow-up fixes, or final passes are still pending — by the time you finish those, the half-baked PR may already be in `main`.
- Push commits to the branch first; only run `gh pr create` once tests pass, live verification (if applicable) is green, and you'd be comfortable with the change shipping as-is.
- If follow-ups land after a PR is already open, they need to land on the same branch *before* auto-review flips to `pass`. Once the PR squash-merges, late commits orphan onto a stale branch and become their own follow-up PR.
- If you genuinely need a checkpoint review without shipping, open the PR as a GitHub draft (`gh pr create --draft …`) — auto-review skips drafts. Mark it ready-for-review only when the feature is truly done.

**Release PRs are the one manual touch.** release-please opens its own release PR and leaves it open as your staging artifact — `pr-auto-review.yml` skips it on purpose, so it sits there accumulating changes until you decide to ship. When you're ready, add `ready-to-merge` to it the same way: `gh pr edit <num> --add-label ready-to-merge`. The `auto-merge.yml` arm then takes over and the publish job fires the moment the release PR lands.

The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

## What to not do

- Don't add IP-rotation or TLS-impersonation libraries. The data is gated by a per-user bearer, not by IP or TLS fingerprint. Anti-bot bypass machinery is the wrong tool here.
- Don't paste cookies — OneHome doesn't have a useful cookie session. The bearer is the source of truth.
- Don't register tools that can't be tested against `FakeTransport`. All tool logic should be behind `OneHomeClient.graphql` so tests can drive it without hitting the network.
- Don't extend the canonical query set without inlining the fields you need — fragments by minified name in the bundle don't roundtrip when we send the document upstream. Use the existing `${FRAGMENT_*}` constants in `src/queries.ts` instead.
- Don't bump versions speculatively. release-please owns that.
