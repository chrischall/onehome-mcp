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
