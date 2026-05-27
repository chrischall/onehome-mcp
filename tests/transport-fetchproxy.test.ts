/**
 * Regression test for issue #26 / PR #9.
 *
 * The FetchproxyTransport calls `bridge.captureRequestHeader(...)` to
 * snapshot the Authorization header from the user's signed-in portal
 * tab. `@fetchproxy/server` rejects that call unless the MCP declared
 * the `'capture_request_header'` capability up front — the default
 * capability set is `['fetch']`, which does not include it.
 *
 * The fix (src/transport-fetchproxy.ts:97) sets `capabilities` on the
 * `FetchproxyServerOpts` passed into `new FetchproxyServer(...)`. This
 * test pins that wiring so it can't regress unnoticed: we mock the
 * `FetchproxyServer` constructor, instantiate `FetchproxyTransport`,
 * and assert the recorded opts include `'capture_request_header'`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchproxyServerOpts } from '@fetchproxy/server';

const constructorCalls: FetchproxyServerOpts[] = [];

vi.mock('@fetchproxy/server', () => {
  class MockFetchproxyServer {
    public role: string | null = 'mock';
    constructor(opts: FetchproxyServerOpts) {
      constructorCalls.push(opts);
    }
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- test stub
    async listen(): Promise<void> {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- test stub
    async close(): Promise<void> {}
    async captureRequestHeader(): Promise<string> {
      return 'Bearer mock';
    }
  }
  return { FetchproxyServer: MockFetchproxyServer };
});

beforeEach(() => {
  constructorCalls.length = 0;
});

describe('FetchproxyTransport — capability declaration', () => {
  it("declares 'capture_request_header' on the FetchproxyServer constructor", async () => {
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    new FetchproxyTransport({ version: '0.0.0-test' });
    expect(constructorCalls.length).toBe(1);
    const opts = constructorCalls[0]!;
    expect(opts.capabilities).toEqual(['capture_request_header']);
  });

  it('declares the captureHeaders entry the runtime needs to snapshot the Authorization header', async () => {
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    new FetchproxyTransport({ version: '0.0.0-test' });
    const opts = constructorCalls[0]!;
    expect(opts.captureHeaders).toEqual([
      {
        urlPattern: 'https://services.onehome.com/graphql*',
        headerName: 'Authorization',
      },
    ]);
  });

  it("identifies the bridge as 'onehome-mcp' against the onehome.com domain", async () => {
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    new FetchproxyTransport({ version: '0.0.0-test' });
    const opts = constructorCalls[0]!;
    expect(opts.serverName).toBe('onehome-mcp');
    expect(opts.domains).toEqual(['onehome.com']);
  });
});
