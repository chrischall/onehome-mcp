import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchproxyServerOpts } from '@fetchproxy/server';

const constructorCalls: FetchproxyServerOpts[] = [];
let captureBehavior: () => Promise<string> = async () => 'Bearer mock';
let captureCallCount = 0;

// Keep the real FetchproxyBridgeDownError around — the mocked server
// throws an instance of it to simulate the post-retry surface the real
// 0.8.0 server presents.
vi.mock('@fetchproxy/server', async () => {
  const actual = await vi.importActual<typeof import('@fetchproxy/server')>(
    '@fetchproxy/server',
  );
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
      captureCallCount += 1;
      return captureBehavior();
    }
    bridgeHealth() {
      return {
        role: this.role,
        port: 0,
        serverVersion: '0.0.0-test',
        fetchTimeoutMs: 0,
        bridgeReviveDelayMs: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureReason: null,
        consecutiveFailures: 0,
        lastExtensionMessageAt: null,
      };
    }
  }
  return {
    ...actual,
    FetchproxyServer: MockFetchproxyServer,
  };
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

  it('does NOT pass bridgeReviveDelayMs (relies on server-side default)', async () => {
    // 0.8.0+ server defaults bridgeReviveDelayMs to 2000. The adapter
    // doesn't override or expose a knob — anyone needing a different
    // value can construct their own FetchproxyServer.
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    new FetchproxyTransport({ version: '0.0.0-test' });
    expect(constructorCalls[0]!.bridgeReviveDelayMs).toBeUndefined();
  });

  it('does NOT pass keepAliveIntervalMs (relies on the server-side 25s default)', async () => {
    // Onehome is Pattern B: the bridge handles a single one-shot
    // Authorization capture at startup, but it stays held open and is
    // hit again whenever the captured JWT expires (see graphql() →
    // ensureToken() recapture path). Without a keep-alive ping the
    // browser SW can evict between refreshes, forcing a lazy-revive
    // round-trip on every token rollover. We used to pin a 25s cadence
    // here; @fetchproxy/server 0.10.0 now defaults keepAliveIntervalMs to
    // exactly 25_000, so the adapter no longer passes it (fetchproxy#72).
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    new FetchproxyTransport({ version: '0.0.0-test' });
    expect(constructorCalls[0]!.keepAliveIntervalMs).toBeUndefined();
  });
});

describe('FetchproxyTransport — capture error surface (post-server-retry)', () => {
  it('re-throws FetchproxyBridgeDownError from the server unwrapped', async () => {
    const { FetchproxyBridgeDownError } = await import('@fetchproxy/server');
    captureBehavior = async () => {
      throw new FetchproxyBridgeDownError({
        originalError: 'Could not establish connection.',
        retryAttempted: true,
        op: 'capture_request_header',
      });
    };
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    const t = new FetchproxyTransport({ version: '0.0.0-test' });
    await t.start();
    await expect(
      t.graphql({ operationName: 'X', query: 'query X { ok }' }),
    ).rejects.toBeInstanceOf(FetchproxyBridgeDownError);
    await expect(
      t.graphql({ operationName: 'X', query: 'query X { ok }' }),
    ).rejects.toMatchObject({ retryAttempted: true });
  });

  it('wraps non-bridge-down errors as FetchproxyAuthCaptureError (e.g. user-interaction timeout)', async () => {
    captureBehavior = async () => {
      throw new Error('timeout: no matching request observed within 120000ms');
    };
    const { FetchproxyTransport, FetchproxyAuthCaptureError } = await import(
      '../src/transport-fetchproxy.js'
    );
    const t = new FetchproxyTransport({ version: '0.0.0-test' });
    await t.start();
    await expect(
      t.graphql({ operationName: 'X', query: 'query X { ok }' }),
    ).rejects.toBeInstanceOf(FetchproxyAuthCaptureError);
  });

  it('re-exports FetchproxyBridgeDownError so callers importing from this module keep working', async () => {
    const mod = await import('../src/transport-fetchproxy.js');
    const fp = await import('@fetchproxy/server');
    expect(mod.FetchproxyBridgeDownError).toBe(fp.FetchproxyBridgeDownError);
  });
});

describe('FetchproxyTransport — status() surface', () => {
  it('surfaces bridgeHealth().lastExtensionMessageAt under fetchproxy', async () => {
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    const t = new FetchproxyTransport({ version: '0.0.0-test' });
    const s = t.status();
    expect(s.fetchproxy).toBeDefined();
    expect(s.fetchproxy).toMatchObject({
      role: 'mock',
      serverVersion: '0.0.0-test',
      lastExtensionMessageAt: null,
    });
  });
});

describe('FetchproxyTransport — successful capture', () => {
  it('strips the Bearer prefix and uses the JWT as the Authorization', async () => {
    captureBehavior = async () => 'Bearer eyJ.mock.token';
    const stubFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
    );
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    const t = new FetchproxyTransport({
      version: '0.0.0-test',
      fetchImpl: stubFetch as unknown as typeof fetch,
    });
    await t.start();
    await t.graphql({ operationName: 'X', query: 'query X { ok }' });
    expect(captureCallCount).toBe(1);
    const headers = (stubFetch.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe('Bearer eyJ.mock.token');
  });
});
