/**
 * Token-handling helpers shared by both transports.
 *
 * OneHome uses bearer-token auth (`Authorization: Bearer <jwt>`)
 * against `services.onehome.com/graphql`. We accept the token from
 * three different sources at startup:
 *
 *   1. `ONEHOME_TOKEN` — raw JWT pasted from the user's devtools.
 *   2. `ONEHOME_MAGIC_LINK` — full URL with `?token=...`; we extract
 *      the `token` query param and use it directly (the portal app's
 *      bundle confirms: `let Ve = ze.queryParams.token || ...`).
 *   3. fetchproxy `captureRequestHeader` — wait for the user's signed-
 *      in portal.onehome.com tab to fire any GraphQL request, snapshot
 *      its Authorization header, and reuse the captured value.
 *
 * Source #3 lives entirely in `transport-fetchproxy.ts`. This module
 * is just the parsing + JWT-introspection helpers.
 */

export interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** Token expiry in unix-ms, derived from `payload.exp` (which is unix-seconds in standard JWT). Null when absent or non-numeric. */
  expiresAt: number | null;
}

/**
 * Decode a JWT enough to read its `exp` claim. Does NOT verify the
 * signature — we never had the signing key to start with, the upstream
 * server does that. This is purely for "is this token about to expire"
 * diagnostics.
 *
 * Returns null if the input doesn't look like a JWT (not three
 * dot-separated base64url segments).
 */
export function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const decode = (seg: string): Record<string, unknown> | null => {
    try {
      const padded = seg + '='.repeat((4 - (seg.length % 4)) % 4);
      const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(normalized, 'base64').toString('utf8');
      const obj = JSON.parse(decoded);
      return typeof obj === 'object' && obj !== null ? obj : null;
    } catch {
      return null;
    }
  };
  const header = decode(parts[0]!);
  const payload = decode(parts[1]!);
  if (!header || !payload) return null;
  let expiresAt: number | null = null;
  if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
    expiresAt = payload.exp * 1000;
  }
  return { header, payload, expiresAt };
}

/**
 * Pull the `token` query param out of a magic-link URL. Accepts any
 * URL shape (with or without scheme) and returns the param value, or
 * null if it isn't present.
 *
 * OneHome's magic links look like
 *   https://portal.onehome.com/en-US/properties/map?token=eyJ...
 * (or any other path on portal.onehome.com).
 */
export function extractTokenFromMagicLink(link: string): string | null {
  // Normalize so the URL parser is happy even with input like
  // "portal.onehome.com/...?token=...".
  let candidate = link.trim();
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  const value = u.searchParams.get('token');
  return value && value.length > 0 ? value : null;
}

export class TokenExpiredError extends Error {
  readonly expiredAt: number;
  constructor(expiredAt: number) {
    const ageSec = Math.round((Date.now() - expiredAt) / 1000);
    super(
      `OneHome bearer token expired ${ageSec}s ago at ${new Date(expiredAt).toISOString()}. ` +
        `Refresh it: open portal.onehome.com (signed-in), grab a new bearer from ` +
        `devtools Network tab, and update ONEHOME_TOKEN — or paste a fresh magic-link ` +
        `URL into ONEHOME_MAGIC_LINK.`
    );
    this.name = 'TokenExpiredError';
    this.expiredAt = expiredAt;
  }
}

export class NoTokenError extends Error {
  constructor() {
    super(
      'onehome-mcp could not source an Authorization bearer token. ' +
        'Set ONEHOME_TOKEN (raw JWT), or ONEHOME_MAGIC_LINK (portal URL with ?token=...), ' +
        'or run with the fetchproxy browser extension connected to a signed-in portal.onehome.com tab.'
    );
    this.name = 'NoTokenError';
  }
}

/**
 * True if `token` looks like a standard JWT (three base64url segments).
 *
 * OneHome's portal URL `?token=...` carries a single-segment base64
 * blob (the email-token: a JSON descriptor of the consumer share —
 * `{ OSN, type, contactid, setid, setkey, email, ..., agentid }`).
 * That blob is NOT a bearer — the SPA exchanges it for a real JWT
 * sessionToken via `/api/authentication/checkToken` before using it.
 *
 * The exchanged sessionToken IS a standard JWT (with `exp` etc.).
 *
 * `ONEHOME_TOKEN` can be either:
 *   - A pre-exchanged sessionToken (paste from devtools Network panel):
 *     three segments → use directly as bearer.
 *   - The raw email-token from the URL: one segment → needs the
 *     checkToken exchange first.
 *
 * `ONEHOME_MAGIC_LINK` always carries the email-token form, since
 * that's what agents email — always exchange.
 */
export function isJwtShape(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0);
}

export interface CheckTokenResponse {
  sessionToken: string;
  groupID?: string;
  savedSearchID?: string;
  agentID?: string;
  contactID?: string;
  mlsID?: string;
  email?: string;
  signedIn?: boolean;
  registered?: boolean;
  rumToken?: string;
  /** Captured raw response for caller diagnostics / unexpected fields. */
  raw: Record<string, unknown>;
}

const CHECK_TOKEN_URL =
  'https://services.onehome.com/api/authentication/checkToken';
const ORIGIN = 'https://portal.onehome.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0 Safari/537.36';

export class CheckTokenError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(
      `OneHome /api/authentication/checkToken rejected the email token ` +
        `(HTTP ${status}). The token may be expired or malformed — ask your ` +
        `real-estate agent to resend the magic link. Upstream body: ` +
        body.slice(0, 200)
    );
    this.name = 'CheckTokenError';
    this.status = status;
  }
}

/**
 * Exchange an email-token (the `?token=` value from a OneHome magic
 * link) for a session-token bearer + session context (groupID,
 * savedSearchID, agentID, …) by POSTing to
 * `/api/authentication/checkToken`. This is the bootstrap step the
 * Angular portal does on app load:
 *
 *   POST /api/authentication/checkToken
 *   { "emailToken": "<URL ?token= value>" }
 *
 * The response carries the bearer (`sessionToken`) plus the consumer's
 * scope (which group / saved search the agent shared with them).
 */
export async function exchangeEmailToken(
  emailToken: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<CheckTokenResponse> {
  const response = await fetchImpl(CHECK_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ emailToken }),
  });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new CheckTokenError(response.status, text);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CheckTokenError(response.status, `non-JSON: ${text}`);
  }
  const sessionToken = parsed.sessionToken;
  if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
    throw new CheckTokenError(
      response.status,
      'response missing sessionToken: ' + text.slice(0, 200)
    );
  }
  const pickString = (k: string): string | undefined =>
    typeof parsed[k] === 'string' ? (parsed[k] as string) : undefined;
  return {
    sessionToken,
    groupID: pickString('groupID'),
    savedSearchID: pickString('savedSearchID'),
    agentID: pickString('agentID'),
    contactID: pickString('contactID'),
    mlsID: pickString('mlsID'),
    email: pickString('email'),
    signedIn:
      typeof parsed.signedIn === 'boolean' ? parsed.signedIn : undefined,
    registered:
      typeof parsed.registered === 'boolean'
        ? parsed.registered
        : undefined,
    rumToken: pickString('rumToken'),
    raw: parsed,
  };
}
