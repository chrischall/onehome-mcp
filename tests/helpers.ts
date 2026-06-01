import type {
  BridgeStatus,
  GraphQLRequest,
  GraphQLResponse,
  OneHomeTransport,
  RestResponse,
} from '../src/transport.js';
import { OneHomeClient } from '../src/client.js';

// The generic in-memory MCP harness now lives in @chrischall/mcp-utils/test
// (byte-identical to the local one it replaced). Re-exported here so the
// domain-specific FakeTransport stays alongside it and the test files keep
// importing both from one module.
export { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';

/**
 * In-memory transport stub for unit tests. Each test registers a
 * handler keyed off `operationName`; calls that don't have a handler
 * throw.
 */
export class FakeTransport implements OneHomeTransport {
  private handlers = new Map<
    string,
    (variables: Record<string, unknown>) => GraphQLResponse
  >();
  private restHandlers = new Map<string, () => RestResponse>();
  private bridgeStatus: BridgeStatus = {
    authMode: 'env_token',
    authReady: true,
    authExpiresAt: null,
    sessionContext: {},
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    consecutiveFailures: 0,
  };
  public calls: Array<{ operationName: string; variables?: Record<string, unknown> }> = [];

  on(
    operationName: string,
    handler: (variables: Record<string, unknown>) => GraphQLResponse | Promise<GraphQLResponse>
  ): this {
    this.handlers.set(operationName, handler as never);
    return this;
  }

  setStatus(partial: Partial<BridgeStatus>): void {
    this.bridgeStatus = { ...this.bridgeStatus, ...partial };
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op
  async start(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op
  async close(): Promise<void> {}

  status(): BridgeStatus {
    return { ...this.bridgeStatus };
  }

  async graphql<T = unknown>(req: GraphQLRequest): Promise<GraphQLResponse<T>> {
    this.calls.push({
      operationName: req.operationName,
      variables: req.variables,
    });
    const handler = this.handlers.get(req.operationName);
    if (!handler) {
      throw new Error(
        `FakeTransport: no handler registered for operation "${req.operationName}". ` +
          `Available: ${Array.from(this.handlers.keys()).join(', ')}`
      );
    }
    const result = await handler(req.variables ?? {});
    return result as GraphQLResponse<T>;
  }

  onRest(pathPrefix: string, handler: () => RestResponse): this {
    this.restHandlers.set(pathPrefix, handler);
    return this;
  }

  async rest<T = unknown>(path: string): Promise<RestResponse<T>> {
    for (const [prefix, handler] of this.restHandlers) {
      if (path.startsWith(prefix)) {
        return handler() as RestResponse<T>;
      }
    }
    throw new Error(
      `FakeTransport.rest: no handler registered for path "${path}". ` +
        `Available prefixes: ${Array.from(this.restHandlers.keys()).join(', ')}`
    );
  }
}

export function makeClient(): { client: OneHomeClient; transport: FakeTransport } {
  const transport = new FakeTransport();
  const client = new OneHomeClient({ transport });
  return { client, transport };
}

/** Build a successful GraphQL response envelope. */
export function ok<T>(data: T): GraphQLResponse<T> {
  return {
    data,
    status: 200,
    url: 'https://services.onehome.com/graphql',
  };
}

