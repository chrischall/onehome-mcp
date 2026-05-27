/**
 * Thin client wrapper over `OneHomeTransport`.
 *
 * Tools depend on `OneHomeClient`, not the transport directly, so the
 * test suite can swap in an in-memory `FakeTransport` without each
 * test having to mock `fetch` itself.
 *
 * Multi-session support
 * ---------------------
 * The client keeps a registry of transports keyed by `session_id`,
 * with one designated as active. The common single-session case is
 * just the registry with one entry; the active session always answers
 * unless a per-request routing hint matches another session's MLS.
 *
 * Routing rule: when a GraphQL request's variables include a
 * `listingId` (or `osks[]` / `listingIds[]`) carrying a `~MLS` suffix
 * (OneHome's OSKs end with `~CANOPY`, `~HCAOR`, …), and one of the
 * registered sessions reports a matching `sessionContext.mlsId`, the
 * request is routed to that session. Otherwise it goes to the active
 * one.
 */

import { parseAuthInput } from './auth.js';
import { DirectTransport } from './transport-direct.js';
import type {
  BridgeStatus,
  GraphQLRequest,
  GraphQLResponse,
  OneHomeTransport,
  RestResponse,
} from './transport.js';

export class GraphQLResponseError extends Error {
  readonly errors: NonNullable<GraphQLResponse['errors']>;
  readonly operationName: string;
  readonly status: number;
  constructor(
    operationName: string,
    status: number,
    errors: NonNullable<GraphQLResponse['errors']>
  ) {
    const summary = errors
      .map((e) => e.message)
      .filter(Boolean)
      .slice(0, 3)
      .join('; ');
    super(
      `OneHome ${operationName} returned ${errors.length} GraphQL error(s) ` +
        `(HTTP ${status}): ${summary}`
    );
    this.name = 'GraphQLResponseError';
    this.operationName = operationName;
    this.status = status;
    this.errors = errors;
  }
}

export interface OneHomeClientOptions {
  transport: OneHomeTransport;
}

/**
 * Public-facing summary of a registered session — used by
 * `client.listSessions()` and the `onehome_get_session_context` tool.
 */
export interface RegisteredSession {
  sessionId: string;
  status: BridgeStatus;
}

/**
 * Pull the `~MLS` suffix off a OneHome OSK. Returns the upper-case MLS
 * identifier (`CANOPY`, `HCAOR`, …) or null if the id doesn't carry
 * one. OneHome's OSKs are formed `<key>~<MLS>` — the suffix is the
 * stable MLS identifier the listing came from.
 *
 * Exported for tests / future routing helpers; not part of the
 * `OneHomeClient` API surface.
 */
export function extractMlsSuffix(listingId: string): string | null {
  const idx = listingId.lastIndexOf('~');
  if (idx < 0 || idx === listingId.length - 1) return null;
  const suffix = listingId.slice(idx + 1);
  // Sanity guard: legitimate MLS codes are short upper-case alpha
  // tokens (CANOPY, HCAOR, TRIANGLE …). Don't route on noise.
  return /^[A-Z][A-Z0-9]{1,15}$/.test(suffix) ? suffix : null;
}

/**
 * Inspect GraphQL variables for a listing-id-shaped value and pull the
 * MLS suffix off the first match. Looks at `listingId`, `id`, and any
 * `osks[]` / `listingIds[]` array entry.
 */
function extractRoutingMls(
  variables: Record<string, unknown> | undefined
): string | null {
  if (!variables) return null;
  const candidates: unknown[] = [];
  if (typeof variables.listingId === 'string') candidates.push(variables.listingId);
  if (typeof variables.id === 'string') candidates.push(variables.id);
  if (Array.isArray(variables.osks)) candidates.push(...variables.osks);
  if (Array.isArray(variables.listingIds)) candidates.push(...variables.listingIds);
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const suffix = extractMlsSuffix(candidate);
    if (suffix) return suffix;
  }
  return null;
}

export class OneHomeClient {
  private sessions = new Map<string, OneHomeTransport>();
  private activeSessionId: string;
  private nextSessionSeq = 1;
  private fetchImpl: typeof fetch | undefined;

  constructor(opts: OneHomeClientOptions) {
    this.activeSessionId = this.allocateSessionId();
    this.sessions.set(this.activeSessionId, opts.transport);
  }

  private allocateSessionId(): string {
    const id = `session-${this.nextSessionSeq}`;
    this.nextSessionSeq += 1;
    return id;
  }

  /**
   * Register an additional transport under a new `session_id` without
   * changing which session is active. Returns the freshly-allocated id.
   *
   * Intentionally NOT used by `setAuthFromInput` — that helper *does*
   * mark the new session active (it's the runtime "switch me to this
   * link" UX). Use `registerSession` directly when you want to wire up
   * a session without making it the default.
   */
  registerSession(transport: OneHomeTransport): string {
    const id = this.allocateSessionId();
    this.sessions.set(id, transport);
    return id;
  }

  /**
   * Switch which registered session answers requests by default.
   * Throws if `sessionId` isn't a known id.
   */
  setActiveSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new Error(
        `OneHomeClient: no session registered with id "${sessionId}". ` +
          `Known: ${Array.from(this.sessions.keys()).join(', ')}`
      );
    }
    this.activeSessionId = sessionId;
  }

  getActiveSessionId(): string {
    return this.activeSessionId;
  }

  /**
   * Snapshot of every registered session — its id + current status.
   * Returned in registration order (Map insertion order).
   */
  listSessions(): RegisteredSession[] {
    return Array.from(this.sessions.entries()).map(([sessionId, transport]) => ({
      sessionId,
      status: transport.status(),
    }));
  }

  /**
   * Bring up all registered sessions. Safe to call repeatedly — each
   * transport's `start()` is idempotent.
   */
  async start(): Promise<void> {
    for (const transport of this.sessions.values()) {
      await transport.start();
    }
  }

  async close(): Promise<void> {
    for (const transport of this.sessions.values()) {
      try {
        await transport.close();
      } catch (err) {
        console.error(
          `[onehome-mcp] warning: transport close failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  /**
   * Status of a specific session, or the active session when no id is
   * provided. Throws for an unknown id.
   */
  bridgeStatus(sessionId?: string): BridgeStatus {
    const id = sessionId ?? this.activeSessionId;
    const transport = this.sessions.get(id);
    if (!transport) {
      throw new Error(
        `OneHomeClient: no session registered with id "${id}". ` +
          `Known: ${Array.from(this.sessions.keys()).join(', ')}`
      );
    }
    return transport.status();
  }

  /**
   * Test-only hook so unit tests can inject a fetch mock that
   * `setAuthFromInput` will plumb into the new `DirectTransport`
   * (which goes straight to `services.onehome.com/checkToken`).
   * Production code never calls this.
   */
  _setFetchImplForTest(fetchImpl: typeof fetch): void {
    this.fetchImpl = fetchImpl;
  }

  /**
   * Pick a transport for a request by inspecting its variables for
   * `~MLS`-suffixed listing ids. Falls back to the active session when
   * nothing matches.
   */
  private routeFor(variables?: Record<string, unknown>): OneHomeTransport {
    if (this.sessions.size > 1) {
      const mls = extractRoutingMls(variables);
      if (mls) {
        for (const [, transport] of this.sessions) {
          const ctxMls = transport.status().sessionContext.mlsId;
          if (ctxMls && ctxMls.toUpperCase() === mls.toUpperCase()) {
            return transport;
          }
        }
      }
    }
    const active = this.sessions.get(this.activeSessionId);
    if (!active) {
      throw new Error(
        `OneHomeClient: active session "${this.activeSessionId}" is not registered.`
      );
    }
    return active;
  }

  /**
   * Register an additional `DirectTransport` built from the supplied
   * input (magic-link URL, JWT bearer, or email-token — see
   * `parseAuthInput`), mark it active, and return its assigned
   * `session_id`. The previously-active session stays in the registry
   * — call `setActiveSession` to switch back, or let MLS-suffix
   * routing pick automatically per listing.
   *
   * Returns `{ sessionId, status, bearer }` so the caller can confirm
   * the resolved bearer (not the raw input) and tell the user which
   * id was assigned. The bearer must not be persisted or logged.
   */
  async setAuthFromInput(
    input: string
  ): Promise<{ sessionId: string; status: BridgeStatus; bearer: string }> {
    const parsed = parseAuthInput(input);
    const next = new DirectTransport({
      token: parsed.token,
      authMode: parsed.source,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    await next.start();
    const sessionId = this.allocateSessionId();
    this.sessions.set(sessionId, next);
    this.activeSessionId = sessionId;
    return { sessionId, status: next.status(), bearer: next.currentBearer() };
  }

  /**
   * Send a GraphQL request and unwrap `data`. Throws
   * `GraphQLResponseError` if the upstream returned `errors`, or a
   * plain `Error` if the response shape was unexpected.
   *
   * Routing: when multiple sessions are registered and the request
   * carries a `~MLS`-suffixed listing id, that session is preferred;
   * otherwise the active session answers.
   */
  async graphql<T = unknown>(req: GraphQLRequest): Promise<T> {
    const transport = this.routeFor(req.variables);
    const result = await transport.graphql<T>(req);
    if (result.errors && result.errors.length > 0) {
      throw new GraphQLResponseError(req.operationName, result.status, result.errors);
    }
    if (result.status >= 400) {
      throw new Error(
        `OneHome ${req.operationName} returned HTTP ${result.status}: ` +
          `${JSON.stringify(result.data ?? null).slice(0, 200)}`
      );
    }
    if (result.data === undefined) {
      throw new Error(
        `OneHome ${req.operationName} returned no \`data\` (HTTP ${result.status}). ` +
          `Upstream response was empty.`
      );
    }
    return result.data;
  }

  /**
   * Raw form — returns the entire response envelope including
   * `errors`. Used by `onehome_graphql` for power users who want to
   * see error details directly.
   */
  async graphqlRaw<T = unknown>(req: GraphQLRequest): Promise<GraphQLResponse<T>> {
    const transport = this.routeFor(req.variables);
    return transport.graphql<T>(req);
  }

  /**
   * Authenticated GET against `services.onehome.com/api{path}`. Used
   * for LocalLogic schools / walk-score endpoints — the bundle wraps
   * them in a GraphQL `@rest` directive that's a client-side Apollo
   * construct (the server doesn't understand it), so we hit the REST
   * URLs directly.
   *
   * REST calls don't carry listing context, so they always go through
   * the active session.
   */
  async rest<T = unknown>(path: string): Promise<RestResponse<T>> {
    const transport = this.routeFor(undefined);
    return transport.rest<T>(path);
  }
}
