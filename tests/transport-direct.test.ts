import { describe, it, expect, vi } from 'vitest';
import {
  DirectTransport,
  tryBuildDirectTransportFromEnv,
} from '../src/transport-direct.js';

const FAKE_JWT_BODY = Buffer.from(JSON.stringify({ exp: 1900000000 }))
  .toString('base64')
  .replace(/=+$/, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');
const FAKE_JWT = `eyJhbGciOiJIUzI1NiJ9.${FAKE_JWT_BODY}.sig`;

function jsonResponse(
  body: unknown,
  init: { status?: number; url?: string } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('tryBuildDirectTransportFromEnv', () => {
  it('builds an env_token transport from ONEHOME_TOKEN', () => {
    const out = tryBuildDirectTransportFromEnv({ ONEHOME_TOKEN: FAKE_JWT });
    expect(out?.authMode).toBe('env_token');
    expect(out?.transport.status().authMode).toBe('env_token');
  });

  it('builds a magic_link transport from ONEHOME_MAGIC_LINK', () => {
    const out = tryBuildDirectTransportFromEnv({
      ONEHOME_MAGIC_LINK: `https://portal.onehome.com/en-US/properties/map?token=${FAKE_JWT}`,
    });
    expect(out?.authMode).toBe('magic_link');
  });

  it('throws when ONEHOME_MAGIC_LINK has no token param', () => {
    expect(() =>
      tryBuildDirectTransportFromEnv({
        ONEHOME_MAGIC_LINK: 'https://portal.onehome.com/en-US/properties/map',
      })
    ).toThrow(/no `token` query parameter/);
  });

  it('treats unsubstituted .mcpb ${user_config.*} placeholders as unset', () => {
    expect(
      tryBuildDirectTransportFromEnv({
        ONEHOME_TOKEN: '${user_config.onehome_token}',
        ONEHOME_MAGIC_LINK: '${user_config.onehome_magic_link}',
      })
    ).toBeNull();
  });

  it('falls through an empty ONEHOME_TOKEN to ONEHOME_MAGIC_LINK', () => {
    const out = tryBuildDirectTransportFromEnv({
      ONEHOME_TOKEN: '',
      ONEHOME_MAGIC_LINK: `https://portal.onehome.com/?token=${FAKE_JWT}`,
    });
    expect(out?.authMode).toBe('magic_link');
  });

  it('returns null when neither env var is set', () => {
    expect(tryBuildDirectTransportFromEnv({})).toBeNull();
  });

  it('prefers ONEHOME_TOKEN when both are set', () => {
    const out = tryBuildDirectTransportFromEnv({
      ONEHOME_TOKEN: FAKE_JWT,
      ONEHOME_MAGIC_LINK: `https://portal.onehome.com/?token=other-token`,
    });
    expect(out?.authMode).toBe('env_token');
  });
});

describe('DirectTransport.graphql', () => {
  it('POSTs to services.onehome.com/graphql with bearer auth', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { user: { userId: 'u1' } } }));
    const transport = new DirectTransport({
      token: FAKE_JWT,
      authMode: 'env_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await transport.graphql({
      operationName: 'GetOneHomeUser',
      query: '{ user { userId } }',
      variables: {},
    });
    expect(result.status).toBe(200);
    expect((result.data as { user: { userId: string } }).user.userId).toBe('u1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://services.onehome.com/graphql');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_JWT}`);
    expect(headers.Origin).toBe('https://portal.onehome.com');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.operationName).toBe('GetOneHomeUser');
    expect(body.variables).toEqual({});
  });

  it('throws on HTTP 401', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errorCode: 'E200100' }, { status: 401 })
    );
    const transport = new DirectTransport({
      token: FAKE_JWT,
      authMode: 'env_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      transport.graphql({
        operationName: 'GetOneHomeUser',
        query: '{ user { userId } }',
      })
    ).rejects.toThrow(/HTTP 401/);
    expect(transport.status().consecutiveFailures).toBe(1);
  });

  it('throws TokenExpiredError when JWT exp is in the past', async () => {
    // Build a JWT with exp far in the past.
    const expiredBody = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 })
    )
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const expiredJwt = `eyJhbGciOiJIUzI1NiJ9.${expiredBody}.sig`;
    const fetchImpl = vi.fn();
    const transport = new DirectTransport({
      token: expiredJwt,
      authMode: 'env_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      transport.graphql({
        operationName: 'GetOneHomeUser',
        query: '{ user { userId } }',
      })
    ).rejects.toThrow(/expired/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('updates success counters on a 200', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { ok: true } }));
    const transport = new DirectTransport({
      token: FAKE_JWT,
      authMode: 'env_token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await transport.graphql({
      operationName: 'GetOneHomeUser',
      query: '{ ok }',
    });
    expect(transport.status().lastSuccessAt).toBeTypeOf('number');
    expect(transport.status().consecutiveFailures).toBe(0);
  });
});

/**
 * fleet-audit#617: an email-token (magic-link) session re-exchanges the
 * retained email-token when the exchanged sessionToken expires, instead of
 * dying with TokenExpiredError; and concurrent first calls share one
 * checkToken exchange.
 */
describe('DirectTransport — email-token re-exchange', () => {
  const jwtWithExp = (expSec: number): string => {
    const b = Buffer.from(JSON.stringify({ exp: expSec }))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    return `eyJhbGciOiJIUzI1NiJ9.${b}.sig`;
  };
  const past = () => jwtWithExp(Math.floor(Date.now() / 1000) - 60);
  const future = () => jwtWithExp(Math.floor(Date.now() / 1000) + 3600);

  function stub(sessionTokens: Array<string | Response>) {
    const tokens = [...sessionTokens];
    let checkTokenCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/checkToken')) {
        checkTokenCalls += 1;
        const next = tokens.shift();
        if (next instanceof Response) return next;
        return jsonResponse({ sessionToken: next, groupID: 'G1' });
      }
      return jsonResponse({ data: { auth: (init?.headers as Record<string, string>).Authorization } });
    });
    return { fetchImpl, checkTokenCalls: () => checkTokenCalls };
  }

  it('re-exchanges the email-token once the session JWT has expired', async () => {
    const fresh = future();
    const { fetchImpl, checkTokenCalls } = stub([past(), fresh]);
    const t = new DirectTransport({
      token: 'eyJPU04iOiJYIn0',
      authMode: 'magic_link',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await t.start();
    const res = await t.graphql<{ auth: string }>({ operationName: 'Op', query: 'q' });
    expect(checkTokenCalls()).toBe(2);
    expect(res.data?.auth).toBe(`Bearer ${fresh}`);
    const rest = await t.rest<{ data: { auth: string } }>('/x');
    expect(rest.status).toBe(200);
    expect(checkTokenCalls()).toBe(2);
  });

  it('re-exchanges on rest() too', async () => {
    const { fetchImpl, checkTokenCalls } = stub([past(), future()]);
    const t = new DirectTransport({
      token: 'eyJPU04iOiJYIn0',
      authMode: 'magic_link',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await t.start();
    const res = await t.rest('/x');
    expect(res.status).toBe(200);
    expect(checkTokenCalls()).toBe(2);
  });

  it('throws TokenExpiredError when the re-exchange fails', async () => {
    const { fetchImpl } = stub([past(), new Response('nope', { status: 401 })]);
    const t = new DirectTransport({
      token: 'eyJPU04iOiJYIn0',
      authMode: 'magic_link',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await t.start();
    await expect(t.graphql({ operationName: 'Op', query: 'q' })).rejects.toMatchObject({
      name: 'TokenExpiredError',
    });
  });

  it('throws TokenExpiredError when the re-exchanged token is still expired', async () => {
    const { fetchImpl } = stub([past(), past()]);
    const t = new DirectTransport({
      token: 'eyJPU04iOiJYIn0',
      authMode: 'magic_link',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await t.start();
    await expect(t.graphql({ operationName: 'Op', query: 'q' })).rejects.toMatchObject({
      name: 'TokenExpiredError',
    });
  });

  it('shares one re-exchange between concurrent callers', async () => {
    const { fetchImpl, checkTokenCalls } = stub([past(), future()]);
    const t = new DirectTransport({
      token: 'eyJPU04iOiJYIn0',
      authMode: 'magic_link',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await t.start();
    await Promise.all(
      Array.from({ length: 6 }, () => t.graphql({ operationName: 'Op', query: 'q' }))
    );
    expect(checkTokenCalls()).toBe(2);
  });

  it('memoizes the in-flight start() so a concurrent fan-out fires one checkToken', async () => {
    const { fetchImpl, checkTokenCalls } = stub([future()]);
    const t = new DirectTransport({
      token: 'eyJPU04iOiJYIn0',
      authMode: 'magic_link',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await Promise.all(
      Array.from({ length: 6 }, () => t.graphql({ operationName: 'Op', query: 'q' }))
    );
    expect(checkTokenCalls()).toBe(1);
  });

  it('clears the memoized start() after a failed exchange so the next call retries', async () => {
    const { fetchImpl, checkTokenCalls } = stub([new Response('down', { status: 500 }), future()]);
    const t = new DirectTransport({
      token: 'eyJPU04iOiJYIn0',
      authMode: 'magic_link',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(t.start()).rejects.toThrow();
    await t.graphql({ operationName: 'Op', query: 'q' });
    expect(checkTokenCalls()).toBe(2);
  });
});
