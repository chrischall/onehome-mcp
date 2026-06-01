import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchproxyServerOpts } from '@chrischall/mcp-utils/fetchproxy';

const constructorCalls: FetchproxyServerOpts[] = [];
let captureBehavior: () => Promise<string> = async () => 'Bearer mock';
let captureCallCount = 0;

// Keep the real FetchproxyBridgeDownError around — the mocked server
// throws an instance of it to simulate the post-retry surface the real
// 0.8.0 server presents.
vi.mock('@chrischall/mcp-utils/fetchproxy', async () => {
  const actual = await vi.importActual<
    typeof import('@chrischall/mcp-utils/fetchproxy')
  >('@chrischall/mcp-utils/fetchproxy');
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

// A JWT whose `exp` claim is already in the past — used to drive the
// token-expiry-drop branch. The transport reads `exp` (seconds) via
// parseJwt and compares `exp*1000 < Date.now()`.
function expiredJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('FetchproxyTransport — rest() token lifecycle (parity with graphql())', () => {
  it('drops an expired captured token and recaptures before the REST fetch', async () => {
    // First capture yields an already-expired JWT; the rest() path must
    // notice and recapture (matching graphql()'s expiry-drop branch)
    // rather than firing a doomed request with a dead bearer.
    let captures = 0;
    captureBehavior = async () => {
      captures += 1;
      return captures === 1 ? expiredJwt() : 'Bearer fresh.token';
    };
    const stubFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    const t = new FetchproxyTransport({
      version: '0.0.0-test',
      fetchImpl: stubFetch as unknown as typeof fetch,
    });
    await t.start();
    await t.rest('/locallogic/scores?lat=1&lng=2');
    expect(captures).toBe(2); // initial expired capture + one recapture
    const headers = (stubFetch.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe('Bearer fresh.token');
  });

  it('recaptures and retries once when the first REST call returns 401', async () => {
    // A 401 means the captured bearer was revoked. Mirror graphql()'s
    // recapture intent: drop the dead token, recapture, and retry the
    // request once — so a stale capture self-heals instead of leaking a
    // hard failure to the caller.
    captureBehavior = async () => 'Bearer stale.token';
    const stubFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
      );
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    const t = new FetchproxyTransport({
      version: '0.0.0-test',
      fetchImpl: stubFetch as unknown as typeof fetch,
    });
    await t.start();
    captureBehavior = (() => {
      let n = 0;
      return async () => (++n === 1 ? 'Bearer stale.token' : 'Bearer fresh.token');
    })();
    const res = await t.rest('/locallogic/schools?lat=1&lng=2');
    expect(stubFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    const retryHeaders = (stubFetch.mock.calls[1][1] as RequestInit)
      .headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer fresh.token');
  });

  it('surfaces a persistent 403 as { ok:false } after one recapture+retry (schools policy denial)', async () => {
    // The LocalLogic schools endpoint is agent-only on consumer-share
    // sessions and returns a *policy* 403 that recapturing can't fix. The
    // transport must still recover gracefully: recapture+retry once, then
    // hand the non-ok response back so the schools tool can surface its
    // friendly "agent-only dataset" message rather than throwing.
    captureBehavior = async () => 'Bearer good.token';
    // Fresh Response per call — real fetch never reuses a body.
    const stubFetch = vi
      .fn()
      .mockImplementation(async () => new Response('Forbidden', { status: 403 }));
    const { FetchproxyTransport } = await import('../src/transport-fetchproxy.js');
    const t = new FetchproxyTransport({
      version: '0.0.0-test',
      fetchImpl: stubFetch as unknown as typeof fetch,
    });
    await t.start();
    const res = await t.rest('/locallogic/schools?lat=1&lng=2');
    expect(stubFetch).toHaveBeenCalledTimes(2); // initial + one retry
    expect(res.status).toBe(403);
    expect(res.ok).toBe(false);
  });
});
