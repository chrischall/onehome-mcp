/**
 * Thin client wrapper over `OneHomeTransport`.
 *
 * Tools depend on `OneHomeClient`, not the transport directly, so the
 * test suite can swap in an in-memory `FakeTransport` without each
 * test having to mock `fetch` itself.
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

export class OneHomeClient {
  private transport: OneHomeTransport;
  private fetchImpl: typeof fetch | undefined;

  constructor(opts: OneHomeClientOptions) {
    this.transport = opts.transport;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  bridgeStatus(): BridgeStatus {
    return this.transport.status();
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
   * Replace the current transport with a `DirectTransport` built from
   * the supplied input. Accepts a magic-link URL, a raw JWT bearer, or
   * an email-token — see `parseAuthInput` for the detection rules.
   *
   * Closes the old transport (so any fetchproxy WebSocket listener is
   * torn down) before swapping in the new one. The new transport's
   * `start()` runs the checkToken exchange when the input is an
   * email-token, so the returned `status` already reflects the
   * exchanged bearer + session context.
   *
   * Returns `{ status, bearer }` so the caller can fingerprint the
   * *resolved* bearer (not the raw input). The bearer travels through
   * exactly one return-value hop within the MCP process and must not
   * be persisted or logged by callers.
   */
  async setAuthFromInput(input: string): Promise<{ status: BridgeStatus; bearer: string }> {
    const parsed = parseAuthInput(input);
    const next = new DirectTransport({
      token: parsed.token,
      authMode: parsed.source,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    await next.start();
    const previous = this.transport;
    this.transport = next;
    try {
      await previous.close();
    } catch (err) {
      // Closing the old fetchproxy bridge can race with in-flight
      // WebSocket teardown; surface a stderr warning but don't fail
      // the auth swap — the new transport is already live and the
      // old one will time out on its own.
      console.error(
        `[onehome-mcp] warning: failed to close previous transport during setAuthFromInput: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    return { status: next.status(), bearer: next.currentBearer() };
  }

  /**
   * Send a GraphQL request and unwrap `data`. Throws
   * `GraphQLResponseError` if the upstream returned `errors`, or a
   * plain `Error` if the response shape was unexpected.
   */
  async graphql<T = unknown>(req: GraphQLRequest): Promise<T> {
    const result = await this.transport.graphql<T>(req);
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
    return this.transport.graphql<T>(req);
  }

  /**
   * Authenticated GET against `services.onehome.com/api{path}`. Used
   * for LocalLogic schools / walk-score endpoints — the bundle wraps
   * them in a GraphQL `@rest` directive that's a client-side Apollo
   * construct (the server doesn't understand it), so we hit the REST
   * URLs directly.
   */
  async rest<T = unknown>(path: string): Promise<RestResponse<T>> {
    return this.transport.rest<T>(path);
  }
}
