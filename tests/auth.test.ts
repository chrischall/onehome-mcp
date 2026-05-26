import { describe, it, expect } from 'vitest';
import {
  extractTokenFromMagicLink,
  parseJwt,
  TokenExpiredError,
} from '../src/auth.js';

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown): string =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature`;
}

describe('parseJwt', () => {
  it('parses a JWT with exp into a unix-ms timestamp', () => {
    const token = makeJwt({ sub: 'u1', exp: 1900000000 });
    const parsed = parseJwt(token);
    expect(parsed?.payload.sub).toBe('u1');
    expect(parsed?.expiresAt).toBe(1900000000 * 1000);
  });

  it('returns null when input has the wrong shape', () => {
    expect(parseJwt('not-a-jwt')).toBeNull();
    expect(parseJwt('a.b')).toBeNull();
  });

  it('still returns parsed payload when exp is absent', () => {
    const token = makeJwt({ sub: 'u1' });
    const parsed = parseJwt(token);
    expect(parsed?.expiresAt).toBeNull();
    expect(parsed?.payload.sub).toBe('u1');
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

describe('TokenExpiredError', () => {
  it('carries the expiry timestamp and a refresh hint', () => {
    const expiredAt = Date.now() - 1000 * 60;
    const err = new TokenExpiredError(expiredAt);
    expect(err.expiredAt).toBe(expiredAt);
    expect(err.message).toContain('ONEHOME_TOKEN');
    expect(err.message).toContain('expired');
  });
});
