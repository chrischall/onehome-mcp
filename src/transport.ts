/**
 * Transport-agnostic interface for the OneHome GraphQL bridge.
 *
 * Unlike the other realty MCPs (compass, redfin, homes) where the
 * primitive is "GET an HTML page through the user's tab", OneHome's
 * portal is a pure Angular SPA and its data lives behind a single
 * GraphQL endpoint at `services.onehome.com/graphql`. So our primitive
 * is `graphql(operationName, query, variables)` — every tool composes
 * one or more GraphQL calls.
 *
 * Two implementations:
 *
 *   - `DirectTransport`  (src/transport-direct.ts): node-fetch straight
 *     to services.onehome.com with an Authorization header sourced from
 *     env (`ONEHOME_TOKEN`) or a magic-link URL (`ONEHOME_MAGIC_LINK`).
 *     No browser involvement. Fastest, simplest, the default once auth
 *     is configured.
 *
 *   - `FetchproxyTransport` (src/transport-fetchproxy.ts): same surface
 *     but routes the GraphQL POST through the user's signed-in
 *     portal.onehome.com Chrome tab via @fetchproxy/server. Used as the
 *     fallback when no env auth is configured — the bridge captures the
 *     Authorization header from the tab's first outbound GraphQL request
 *     and then reuses it for subsequent calls.
 *
 * The choice happens once at startup (`src/index.ts`); both transports
 * implement the same `OneHomeTransport` interface so the client + tools
 * are oblivious.
 */

export interface GraphQLRequest {
  operationName: string;
  /** Full GraphQL document text. */
  query: string;
  variables?: Record<string, unknown>;
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: Record<string, unknown>;
    path?: Array<string | number>;
  }>;
  /** HTTP status from the upstream response. */
  status: number;
  /** Final URL hit (after any redirects). */
  url: string;
}

export type AuthMode = 'env_token' | 'magic_link' | 'fetchproxy_capture';

/**
 * Session context returned by the `checkToken` exchange — the scope
 * the email-token was minted against. Used by tools to default
 * `groupId` / `savedSearchId` when the caller doesn't supply them, so
 * the most common single-consumer-share workflow needs zero arguments.
 *
 * Populated only when the bearer was sourced via the
 * `magic_link` path (or an `env_token` that happened to be an
 * email-token rather than a JWT). `fetchproxy_capture` cannot derive
 * this — we only see the captured Authorization header, not the
 * exchange response.
 */
export interface SessionContext {
  groupId?: string;
  savedSearchId?: string;
  agentId?: string;
  contactId?: string;
  mlsId?: string;
  email?: string;
}

export interface BridgeStatus {
  /** Which authentication path the transport bootstrapped from. */
  authMode: AuthMode;
  /** True if we have a usable bearer token (cached or freshly captured). */
  authReady: boolean;
  /** Last-known token expiry in unix-ms, derived from JWT `exp` if present. Null if not known. */
  authExpiresAt: number | null;
  /**
   * Session scope acquired during the token exchange (if any). Empty
   * object when the transport couldn't derive context (raw JWT in env,
   * or fetchproxy-captured header).
   */
  sessionContext: SessionContext;
  /** Unix-ms of the last successful GraphQL call. Null until first success. */
  lastSuccessAt: number | null;
  /** Unix-ms of the last failed GraphQL call. Null until first failure. */
  lastFailureAt: number | null;
  lastFailureReason: string | null;
  consecutiveFailures: number;
  /** Fetchproxy-specific diagnostics. Only populated when authMode === 'fetchproxy_capture'. */
  fetchproxy?: {
    role: 'host' | 'peer' | null;
    port: number;
    serverVersion: string;
    /**
     * 0.8.0+: wall-clock unix-ms of the most recent inner frame the
     * bridge received from the extension (success OR error). Distinct
     * from `lastSuccessAt`/`lastFailureAt`, which track user-visible
     * GraphQL outcomes. Useful for "is the extension still answering?"
     * between captures — e.g. when the captured token expires mid-
     * session and we need to recapture. Null until the first frame
     * arrives.
     */
    lastExtensionMessageAt: number | null;
  };
}

export interface RestResponse<T = unknown> {
  status: number;
  url: string;
  /** Parsed JSON body when content-type was JSON; raw string otherwise. */
  data: T | string;
  /** True when status was 2xx AND body parsed as JSON. */
  ok: boolean;
}

export interface OneHomeTransport {
  /** Bring the transport up. Idempotent. */
  start(): Promise<void>;

  /** Tear the transport down. Idempotent. */
  close(): Promise<void>;

  /**
   * Send a GraphQL request to services.onehome.com. Returns
   * `{ data?, errors?, status, url }`. The transport injects auth +
   * standard headers; the caller only provides the operation +
   * variables.
   */
  graphql<T = unknown>(req: GraphQLRequest): Promise<GraphQLResponse<T>>;

  /**
   * Send an authenticated REST request to `services.onehome.com/api{path}`.
   * Used by the LocalLogic schools / walk-score tools — the upstream
   * bundle calls them via Apollo's `@rest` directive, which is purely
   * a client-side rewrite that we can't replicate server-side.
   *
   * Path is prepended with `/api`. Pass any leading slash, e.g.
   * `/locallogic/scores?lat=...&lng=...`.
   */
  rest<T = unknown>(path: string): Promise<RestResponse<T>>;

  /** Diagnostic snapshot, safe to call at any time. */
  status(): BridgeStatus;
}
