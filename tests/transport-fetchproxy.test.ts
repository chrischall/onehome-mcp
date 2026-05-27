import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchproxyServerOpts } from '@fetchproxy/server';

const constructorCalls: FetchproxyServerOpts[] = [];
let captureBehavior: (callIndex: number) => Promise<string> = async () =>
  'Bearer mock';
let captureCallCount = 0;

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
      const i = captureCallCount++;
      return captureBehavior(i);
    }
  }
  return { FetchproxyServer: MockFetchproxyServer };
});

beforeEach(() => {
  constructorCalls.length = 0;
  captureBehavior = async () => 'Bearer mock';
  captureCallCount = 0;
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

describe('FetchproxyTransport — SW eviction lazy-revive (#38)', () => {
  it('retries captureRequestHeader once after bridgeReviveDelayMs when the SW is unreachable', async () => {
    captureBehavior = async (i) => {
      if (i === 0) throw new Error('Could not establish connection. Receiving end does not exist.');
      return 'Bearer recovered';
    };
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    const t = new FetchproxyTransport({
      version: '0.0.0-test',
      bridgeReviveDelayMs: 1,
    });
    await t.start();
    // The first ensureToken() should succeed on the second internal capture attempt.
    const status = t.status();
    expect(status.authReady).toBe(false);
    // Exercise via a fetch path that calls ensureToken — use the
    // public capture seam by issuing a graphql call with a stub fetch.
    const stubFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
    );
    const t2 = new FetchproxyTransport({
      version: '0.0.0-test',
      bridgeReviveDelayMs: 1,
      fetchImpl: stubFetch as unknown as typeof fetch,
    });
    await t2.start();
    const result = await t2.graphql({
      operationName: 'X',
      query: 'query X { ok }',
    });
    expect(result.status).toBe(200);
    expect(captureCallCount).toBe(2);
  });

  it('throws FetchproxyBridgeDownError with retryAttempted=true after the second capture also fails', async () => {
    captureBehavior = async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    };
    const { FetchproxyTransport, FetchproxyBridgeDownError } = await import(
      '../src/transport-fetchproxy.js'
    );
    const t = new FetchproxyTransport({
      version: '0.0.0-test',
      bridgeReviveDelayMs: 1,
    });
    await t.start();
    await expect(
      t.graphql({ operationName: 'X', query: 'query X { ok }' })
    ).rejects.toMatchObject({
      name: 'FetchproxyBridgeDownError',
      retryAttempted: true,
    });
    expect(captureCallCount).toBe(2);
    // The error must be the typed class, not the generic capture error.
    try {
      await new FetchproxyTransport({
        version: '0.0.0-test',
        bridgeReviveDelayMs: 1,
      }).graphql({ operationName: 'X', query: 'query X { ok }' });
    } catch (err) {
      expect(err).toBeInstanceOf(FetchproxyBridgeDownError);
    }
  });

  it('skips the retry entirely when bridgeReviveDelayMs=0 and surfaces retryAttempted=false', async () => {
    captureBehavior = async () => {
      throw new Error('Receiving end does not exist.');
    };
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    const t = new FetchproxyTransport({
      version: '0.0.0-test',
      bridgeReviveDelayMs: 0,
    });
    await t.start();
    await expect(
      t.graphql({ operationName: 'X', query: 'query X { ok }' })
    ).rejects.toMatchObject({
      name: 'FetchproxyBridgeDownError',
      retryAttempted: false,
    });
    expect(captureCallCount).toBe(1);
  });

  it('does NOT retry on non-SW capture errors (e.g. user-interaction timeout)', async () => {
    captureBehavior = async () => {
      throw new Error('timeout: no matching request observed within 120000ms');
    };
    const { FetchproxyTransport, FetchproxyAuthCaptureError } = await import(
      '../src/transport-fetchproxy.js'
    );
    const t = new FetchproxyTransport({
      version: '0.0.0-test',
      bridgeReviveDelayMs: 1,
    });
    await t.start();
    await expect(
      t.graphql({ operationName: 'X', query: 'query X { ok }' })
    ).rejects.toBeInstanceOf(FetchproxyAuthCaptureError);
    expect(captureCallCount).toBe(1);
  });

  it('FetchproxyBridgeDownError message points at the recovery click + retry-attempted state', async () => {
    captureBehavior = async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    };
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    const t = new FetchproxyTransport({
      version: '0.0.0-test',
      bridgeReviveDelayMs: 1,
    });
    await t.start();
    try {
      await t.graphql({ operationName: 'X', query: 'query X { ok }' });
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/extension/i);
      expect(msg).toMatch(/click/i);
      expect(msg).toMatch(/already tried/i);
    }
  });
});
