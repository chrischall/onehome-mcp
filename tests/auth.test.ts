import { describe, it, expect, vi } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import {
  CheckTokenError,
  CheckTokenTimeoutError,
  decodeJwtExpiresAtMs,
  exchangeEmailToken,
  extractTokenFromMagicLink,
  isJwtShape,
  parseAuthInput,
  TokenExpiredError,
} from '../src/auth.js';

function jsonResponse(
  body: unknown,
  init: { status?: number } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown): string =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature`;
}

describe('decodeJwtExpiresAtMs', () => {
  it('decodes a JWT exp claim into a unix-ms timestamp', () => {
    const token = makeJwt({ sub: 'u1', exp: 1900000000 });
    expect(decodeJwtExpiresAtMs(token)).toBe(1900000000 * 1000);
  });

  it('returns null when input is not a decodable JWT', () => {
    expect(decodeJwtExpiresAtMs('not-a-jwt')).toBeNull();
    expect(decodeJwtExpiresAtMs('eyJsingle-segment-blob')).toBeNull();
  });

  it('returns null when exp is absent or non-numeric', () => {
    expect(decodeJwtExpiresAtMs(makeJwt({ sub: 'u1' }))).toBeNull();
    expect(decodeJwtExpiresAtMs(makeJwt({ exp: 'soon' }))).toBeNull();
  });
});

describe('isJwtShape', () => {
  it('accepts a 3-segment token', () => {
    expect(isJwtShape(makeJwt({ sub: 'u1' }))).toBe(true);
    expect(isJwtShape('a.b.c')).toBe(true);
  });

  it('rejects single-segment email-tokens and other shapes', () => {
    expect(isJwtShape('eyJsingle-segment-blob')).toBe(false);
    expect(isJwtShape('a.b')).toBe(false);
    expect(isJwtShape('a.b.c.d')).toBe(false);
    expect(isJwtShape('a..c')).toBe(false);
    expect(isJwtShape('')).toBe(false);
  });
});

describe('extractTokenFromMagicLink', () => {
  it('pulls ?token= from a full portal URL', () => {
    expect(
      extractTokenFromMagicLink(
        'https://portal.onehome.com/en-US/properties/map?token=abc123'
      )
    ).toBe('abc123');
  });

  it('accepts a URL with no scheme', () => {
    expect(
      extractTokenFromMagicLink(
        'portal.onehome.com/en-US/properties/map?token=xyz'
      )
    ).toBe('xyz');
  });

  it('returns null when token is missing', () => {
    expect(
      extractTokenFromMagicLink('https://portal.onehome.com/en-US/')
    ).toBeNull();
  });

  it('returns null on garbage input', () => {
    expect(extractTokenFromMagicLink('::::')).toBeNull();
  });
});

describe('parseAuthInput', () => {
  it('treats a full URL with ?token= as magic_link', () => {
    expect(
      parseAuthInput(
        'https://portal.onehome.com/en-US/properties/map?token=abc123'
      )
    ).toEqual({ token: 'abc123', source: 'magic_link' });
  });

  it('treats a scheme-less URL with ?token= as magic_link', () => {
    expect(parseAuthInput('portal.onehome.com/x?token=xyz')).toEqual({
      token: 'xyz',
      source: 'magic_link',
    });
  });

  it('treats a 3-segment JWT as env_token (used directly)', () => {
    const jwt = makeJwt({ sub: 'u1', exp: 1900000000 });
    expect(parseAuthInput(jwt)).toEqual({ token: jwt, source: 'env_token' });
  });

  it('treats a single-segment email-token as env_token (will need exchange)', () => {
    expect(parseAuthInput('eyJsingle-segment-blob')).toEqual({
      token: 'eyJsingle-segment-blob',
      source: 'env_token',
    });
  });

  it('throws when the URL is missing ?token=', () => {
    expect(() =>
      parseAuthInput('https://portal.onehome.com/en-US/properties/map')
    ).toThrow(/no `token` query parameter/);
  });

  it('throws on empty input', () => {
    expect(() => parseAuthInput('')).toThrow();
    expect(() => parseAuthInput('   ')).toThrow();
  });

  it('trims surrounding whitespace', () => {
    expect(parseAuthInput('  abc.def.ghi  ')).toEqual({
      token: 'abc.def.ghi',
      source: 'env_token',
    });
  });
});

describe('TokenExpiredError', () => {
  it('carries the expiry timestamp and a refresh hint', () => {
    const expiredAt = Date.now() - 1000 * 60;
    const err = new TokenExpiredError(expiredAt);
    expect(err.expiredAt).toBe(expiredAt);
    expect(err.message).toContain('ONEHOME_TOKEN');
    expect(err.message).toContain('expired');
  });

  it('mentions the onehome_set_auth tool as an in-session refresh path', () => {
    const err = new TokenExpiredError(Date.now() - 1000);
    expect(err.message).toContain('onehome_set_auth');
  });

  it('extends McpToolError and carries the refresh hint', () => {
    const err = new TokenExpiredError(Date.now() - 1000);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.hint).toContain('onehome_set_auth');
  });
});

describe('exchangeEmailToken deadline + classification (issue #55)', () => {
  it('fails fast with a timeout error when the transport never responds', async () => {
    // A stale/invalid token can make upstream accept the connection but
    // never send a response. Without a per-attempt deadline this wedges
    // for the full MCP client timeout (~4 min). It must reject fast instead.
    const fetchImpl = vi.fn(
      () => new Promise<Response>(() => {}) // never resolves
    ) as unknown as typeof fetch;

    const started = Date.now();
    await expect(
      exchangeEmailToken('stale-email-token', fetchImpl, { deadlineMs: 20 })
    ).rejects.toBeInstanceOf(CheckTokenTimeoutError);
    // Well under the (test) deadline window + slack; nowhere near a hang.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('classifies the timeout distinctly from a token rejection', async () => {
    const fetchImpl = vi.fn(
      () => new Promise<Response>(() => {})
    ) as unknown as typeof fetch;
    const err = await exchangeEmailToken('t', fetchImpl, {
      deadlineMs: 10,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckTokenTimeoutError);
    expect(err).not.toBeInstanceOf(CheckTokenError);
    expect((err as CheckTokenTimeoutError).deadlineMs).toBe(10);
    expect((err as Error).message).toMatch(/timed out|timeout/i);
  });

  it('still classifies an HTTP 401 as a fast token-expired/invalid CheckTokenError', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('unauthorized', { status: 401 })
    ) as unknown as typeof fetch;
    const err = await exchangeEmailToken('expired', fetchImpl, {
      deadlineMs: 20,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckTokenError);
    expect(err).not.toBeInstanceOf(CheckTokenTimeoutError);
    expect((err as CheckTokenError).status).toBe(401);
  });

  it('resolves normally on a fast happy-path exchange', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ sessionToken: 'jwt-xyz', groupID: 'g1' })
    ) as unknown as typeof fetch;
    const res = await exchangeEmailToken('email-token', fetchImpl, {
      deadlineMs: 5000,
    });
    expect(res.sessionToken).toBe('jwt-xyz');
    expect(res.groupID).toBe('g1');
  });
});
