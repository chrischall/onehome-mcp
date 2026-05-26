import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  BridgeStatus,
  GraphQLRequest,
  GraphQLResponse,
  OneHomeTransport,
  RestResponse,
} from '../src/transport.js';
import { OneHomeClient } from '../src/client.js';

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

/**
 * Spin up an in-memory MCP client/server pair so tests can invoke
 * tools the same way the host client would (via `client.callTool`).
 * Mirrors the harness compass-mcp uses — running through the actual
 * SDK transport catches schema-validation and shape mistakes that a
 * direct handler call would miss.
 */
export async function createTestHarness(
  registerFn: (server: McpServer) => void
): Promise<{
  client: Client;
  server: McpServer;
  callTool: (
    name: string,
    args?: Record<string, unknown>
  ) => Promise<CallToolResult>;
  listTools: () => Promise<{ name: string }[]>;
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerFn(server);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    server,
    callTool: async (name, args) =>
      client.callTool({ name, arguments: args ?? {} }) as Promise<CallToolResult>,
    listTools: async () => {
      const result = await client.listTools();
      return result.tools.map((t) => ({ name: t.name }));
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
