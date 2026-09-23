import { describe, it, expect } from 'vitest';
import { withCallSignal } from '@chrischall/mcp-utils';
import {
  fetchTextWithDeadline,
  OneHomeRequestTimeoutError,
  REQUEST_TIMEOUT_MS,
} from '../src/request-deadline.js';
import { DirectTransport } from '../src/transport-direct.js';
import { FetchproxyTransport } from '../src/transport-fetchproxy.js';

// chrischall/fleet-audit#192: GraphQL/REST fetches had no deadline and
// ignored MCP cancellation, so a stalled services.onehome.com wedged the
// tool until the client's multi-minute timeout.

const FAKE_JWT_BODY = Buffer.from(JSON.stringify({ exp: 4102444800 }))
  .toString('base64')
  .replace(/=+$/, '');
const FAKE_JWT = `eyJhbGciOiJIUzI1NiJ9.${FAKE_JWT_BODY}.sig`;

/** A fetch that never settles on its own — only an abort ends it. */
function hangingFetch(seen: { signal?: AbortSignal | null }): typeof fetch {
  return ((_url: unknown, init?: RequestInit) => {
    seen.signal = init?.signal ?? null;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
}

/** Responds promptly, but the body never finishes streaming. */
function stalledBodyFetch(): typeof fetch {
  return (async () =>
    new Response(new ReadableStream({ start() {} }), { status: 200 })) as typeof fetch;
}

describe('fetchTextWithDeadline', () => {
  it('defaults to a deadline well under the MCP client timeout', () => {
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('rejects with OneHomeRequestTimeoutError when fetch never settles', async () => {
    const seen: { signal?: AbortSignal | null } = {};
    const err = await fetchTextWithDeadline(hangingFetch(seen), 'https://x', {}, {
      label: 'OneHome GraphQL Foo',
      timeoutMs: 20,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OneHomeRequestTimeoutError);
    expect(err.timeoutMs).toBe(20);
    expect(err.message).toMatch(/OneHome GraphQL Foo timed out after 20ms/);
    expect(seen.signal?.aborted).toBe(true);
  });

  it('covers the body read, not just the headers', async () => {
    const err = await fetchTextWithDeadline(stalledBodyFetch(), 'https://x', {}, {
      label: 'x',
      timeoutMs: 20,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OneHomeRequestTimeoutError);
  });

  it('returns the response and body text on success', async () => {
    const out = await fetchTextWithDeadline(
      (async () => new Response('hello', { status: 201 })) as typeof fetch,
      'https://x',
      {},
      { label: 'x', timeoutMs: 1000 }
    );
    expect(out.response.status).toBe(201);
    expect(out.text).toBe('hello');
  });

  it('honours the MCP call cancellation signal', async () => {
    const controller = new AbortController();
    const seen: { signal?: AbortSignal | null } = {};
    const p = withCallSignal(controller.signal, () =>
      fetchTextWithDeadline(hangingFetch(seen), 'https://x', {}, {
        label: 'x',
        timeoutMs: 60_000,
      })
    );
    controller.abort(new Error('client cancelled'));
    const err = await p.catch((e) => e);
    expect(err).not.toBeInstanceOf(OneHomeRequestTimeoutError);
    expect(err.message).toBe('client cancelled');
    expect(seen.signal?.aborted).toBe(true);
  });
});

describe('DirectTransport request deadline', () => {
  it('graphql() times out instead of hanging', async () => {
    const t = new DirectTransport({
      token: FAKE_JWT,
      authMode: 'env_token',
      fetchImpl: hangingFetch({}),
      requestTimeoutMs: 20,
    });
    await expect(
      t.graphql({ operationName: 'Foo', query: 'q' })
    ).rejects.toBeInstanceOf(OneHomeRequestTimeoutError);
    expect(t.status().consecutiveFailures).toBe(1);
    expect(t.status().lastFailureReason).toMatch(/timed out/);
  });

  it('rest() times out instead of hanging', async () => {
    const t = new DirectTransport({
      token: FAKE_JWT,
      authMode: 'env_token',
      fetchImpl: stalledBodyFetch(),
      requestTimeoutMs: 20,
    });
    await expect(t.rest('/locallogic/scores')).rejects.toBeInstanceOf(
      OneHomeRequestTimeoutError
    );
  });
});

describe('FetchproxyTransport request deadline', () => {
  it('graphql() times out instead of hanging', async () => {
    const t = new FetchproxyTransport({
      version: '0.0.0-test',
      _testToken: FAKE_JWT,
      fetchImpl: hangingFetch({}),
      requestTimeoutMs: 20,
    });
    await expect(
      t.graphql({ operationName: 'Foo', query: 'q' })
    ).rejects.toBeInstanceOf(OneHomeRequestTimeoutError);
  });

  it('rest() times out instead of hanging', async () => {
    const t = new FetchproxyTransport({
      version: '0.0.0-test',
      _testToken: FAKE_JWT,
      fetchImpl: stalledBodyFetch(),
      requestTimeoutMs: 20,
    });
    await expect(t.rest('/locallogic/scores')).rejects.toBeInstanceOf(
      OneHomeRequestTimeoutError
    );
  });
});
