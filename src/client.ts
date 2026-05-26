/**
 * Thin client wrapper over `OneHomeTransport`.
 *
 * Tools depend on `OneHomeClient`, not the transport directly, so the
 * test suite can swap in an in-memory `FakeTransport` without each
 * test having to mock `fetch` itself.
 */

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
  private readonly transport: OneHomeTransport;

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
